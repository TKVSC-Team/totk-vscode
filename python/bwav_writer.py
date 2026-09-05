"""Encode PCM audio to Nintendo BWAV (DSP-ADPCM) files.

The DSP-ADPCM coefficient/frame encoder is a port of the public reference
implementation (jackoalan/gc-dspadpcm-encode, itself derived from Nintendo's
DSPADPCM tool), producing output compatible with the game's decoder.

BWAV layout (little endian, version 1):
  0x00  4  "BWAV"
  0x04  2  BOM (0xFEFF)
  0x06  2  version (1)
  0x08  4  CRC32 of all channels' sample data concatenated (exact frames)
  0x0C  2  prefetch flag (0 = full file, 1 = prefetch clip)
  0x0E  2  channel count
  0x10     channel info array, 0x4C bytes each:
    +0x00  2  codec (0=PCM16, 1=DSP-ADPCM, 2=Opus)
    +0x02  2  channel pan (0=L, 1=R, 2=C)
    +0x04  4  sample rate
    +0x08  4  num samples (full, non-prefetch)
    +0x0C  4  num samples (in this file)
    +0x10 32  DSP coefficients (16 x s16)
    +0x30  4  sample data offset (full, non-prefetch)
    +0x34  4  sample data offset (in this file)
    +0x38  4  flag (always 1)
    +0x3C  4  loop end sample (-1 = no loop)
    +0x40  4  loop start sample
    +0x44  2  initial predictor/scale
    +0x46  2  history sample 1
    +0x48  2  history sample 2
    +0x4A  2  padding
Channel sample data blocks are 0x40-aligned; the file ends exactly after the
last channel's final frame (no trailing padding).
"""

from __future__ import annotations

import os
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

_BWAV_MAGIC = b"BWAV"
_FRAME_SAMPLES = 14
_FRAME_BYTES = 8
_PREFETCH_SAMPLES = 0x3800  # samples kept in a prefetch clip (1024 frames)


# ---------------------------------------------------------------------------
# WAV parsing
# ---------------------------------------------------------------------------


@dataclass
class WavData:
    sample_rate: int
    channels: list[list[int]]  # per-channel PCM16 samples
    loop_start: int | None = None  # from smpl chunk, in samples
    loop_end: int | None = None


def parse_wav(wav_bytes: bytes) -> WavData:
    """Parse a RIFF WAV file (PCM16/PCM24/PCM32/float32) into per-channel PCM16."""
    if len(wav_bytes) < 12 or wav_bytes[:4] != b"RIFF" or wav_bytes[8:12] != b"WAVE":
        raise ValueError("Not a RIFF WAV file")

    fmt = None
    data = None
    loop_start = None
    loop_end = None

    pos = 12
    while pos + 8 <= len(wav_bytes):
        chunk_id = wav_bytes[pos : pos + 4]
        chunk_size = struct.unpack_from("<I", wav_bytes, pos + 4)[0]
        body = wav_bytes[pos + 8 : pos + 8 + chunk_size]
        if chunk_id == b"fmt ":
            fmt = body
        elif chunk_id == b"data":
            data = body
        elif chunk_id == b"smpl" and len(body) >= 0x34:
            num_loops = struct.unpack_from("<I", body, 0x1C)[0]
            if num_loops >= 1:
                loop_start = struct.unpack_from("<I", body, 0x2C)[0]
                loop_end = struct.unpack_from("<I", body, 0x30)[0]
        pos += 8 + chunk_size + (chunk_size & 1)

    if fmt is None or data is None:
        raise ValueError("WAV file is missing fmt or data chunk")

    audio_format, num_channels, sample_rate = struct.unpack_from("<HHI", fmt, 0)
    bits_per_sample = struct.unpack_from("<H", fmt, 14)[0]
    if audio_format == 0xFFFE and len(fmt) >= 0x1A:  # WAVE_FORMAT_EXTENSIBLE
        audio_format = struct.unpack_from("<H", fmt, 0x18)[0]

    if num_channels < 1:
        raise ValueError("WAV has no channels")

    if audio_format == 1 and bits_per_sample == 16:
        interleaved = list(struct.unpack(f"<{len(data) // 2}h", data[: len(data) // 2 * 2]))
    elif audio_format == 1 and bits_per_sample == 24:
        n = len(data) // 3
        interleaved = [
            int.from_bytes(data[i * 3 : i * 3 + 3], "little", signed=True) >> 8 for i in range(n)
        ]
    elif audio_format == 1 and bits_per_sample == 32:
        raw = struct.unpack(f"<{len(data) // 4}i", data[: len(data) // 4 * 4])
        interleaved = [s >> 16 for s in raw]
    elif audio_format == 3 and bits_per_sample == 32:
        raw = struct.unpack(f"<{len(data) // 4}f", data[: len(data) // 4 * 4])
        interleaved = [max(-32768, min(32767, int(round(s * 32767.0)))) for s in raw]
    else:
        raise ValueError(
            f"Unsupported WAV format (format={audio_format}, bits={bits_per_sample}); "
            "use 16-bit PCM, 24-bit PCM, or 32-bit float"
        )

    frame_count = len(interleaved) // num_channels
    channels = [interleaved[c::num_channels][:frame_count] for c in range(num_channels)]
    return WavData(
        sample_rate=sample_rate,
        channels=channels,
        loop_start=loop_start,
        loop_end=loop_end,
    )


# ---------------------------------------------------------------------------
# DSP-ADPCM coefficient calculation (port of DSPCorrelateCoefs)
# ---------------------------------------------------------------------------


def _inner_product_merge(pcm: list[int], base: int) -> list[float]:
    vec = [0.0, 0.0, 0.0]
    for i in range(3):
        acc = 0.0
        for x in range(14):
            acc -= pcm[base + x - i] * pcm[base + x]
        vec[i] = acc
    return vec


def _outer_product_merge(pcm: list[int], base: int) -> list[list[float]]:
    mtx = [[0.0] * 3 for _ in range(3)]
    for x in range(1, 3):
        for y in range(1, 3):
            acc = 0.0
            for z in range(14):
                acc += pcm[base + z - x] * pcm[base + z - y]
            mtx[x][y] = acc
    return mtx


def _analyze_ranges(mtx: list[list[float]], vec_idxs: list[int]) -> bool:
    recips = [0.0] * 3
    for x in range(1, 3):
        val = max(abs(mtx[x][1]), abs(mtx[x][2]))
        if val < 2.2204460492503131e-16:
            return True
        recips[x] = 1.0 / val

    max_index = 0
    for i in range(1, 3):
        for x in range(1, i):
            tmp = mtx[x][i]
            for y in range(1, x):
                tmp -= mtx[x][y] * mtx[y][i]
            mtx[x][i] = tmp

        val = 0.0
        for x in range(i, 3):
            tmp = mtx[x][i]
            for y in range(1, i):
                tmp -= mtx[x][y] * mtx[y][i]
            mtx[x][i] = tmp
            tmp = abs(tmp) * recips[x]
            if tmp >= val:
                val = tmp
                max_index = x

        if max_index != i:
            for y in range(1, 3):
                mtx[max_index][y], mtx[i][y] = mtx[i][y], mtx[max_index][y]
            recips[max_index] = recips[i]

        vec_idxs[i] = max_index

        if mtx[i][i] == 0.0:
            return True

        if i != 2:
            tmp = 1.0 / mtx[i][i]
            for x in range(i + 1, 3):
                mtx[x][i] *= tmp

    vmin = 1.0e10
    vmax = 0.0
    for i in range(1, 3):
        tmp = abs(mtx[i][i])
        vmin = min(vmin, tmp)
        vmax = max(vmax, tmp)
    return vmin / vmax < 1.0e-10


def _bidirectional_filter(mtx: list[list[float]], vec_idxs: list[int], vec: list[float]) -> None:
    x = 0
    for i in range(1, 3):
        index = vec_idxs[i]
        tmp = vec[index]
        vec[index] = vec[i]
        if x != 0:
            for y in range(x, i):
                tmp -= vec[y] * mtx[i][y]
        elif tmp != 0.0:
            x = i
        vec[i] = tmp

    for i in range(2, 0, -1):
        tmp = vec[i]
        for y in range(i + 1, 3):
            tmp -= vec[y] * mtx[i][y]
        vec[i] = tmp / mtx[i][i]

    vec[0] = 1.0


def _quadratic_merge(vec: list[float]) -> bool:
    v2 = vec[2]
    tmp = 1.0 - (v2 * v2)
    if tmp == 0.0:
        return True
    v0 = (vec[0] - (v2 * v2)) / tmp
    v1 = (vec[1] - (vec[1] * v2)) / tmp
    vec[0] = v0
    vec[1] = v1
    return abs(v1) > 1.0


def _finish_record(vin: list[float], out: list[float]) -> None:
    for z in range(1, 3):
        if vin[z] >= 1.0:
            vin[z] = 0.9999999999
        elif vin[z] <= -1.0:
            vin[z] = -0.9999999999
    out[0] = 1.0
    out[1] = (vin[2] * vin[1]) + vin[1]
    out[2] = vin[2]


def _matrix_filter(src: list[float], dst: list[float]) -> None:
    mtx = [[0.0] * 3 for _ in range(3)]
    mtx[2][0] = 1.0
    for i in range(1, 3):
        mtx[2][i] = -src[i]

    for i in range(2, 0, -1):
        val = 1.0 - (mtx[i][i] * mtx[i][i])
        for y in range(1, i + 1):
            mtx[i - 1][y] = ((mtx[i][i] * mtx[i][y]) + mtx[i][y]) / val

    dst[0] = 1.0
    for i in range(1, 3):
        dst[i] = 0.0
        for y in range(1, i + 1):
            dst[i] += mtx[i][y] * dst[i - y]


def _merge_finish_record(src: list[float], dst: list[float]) -> None:
    tmp = [0.0] * 3
    val = src[0]
    dst[0] = 1.0
    for i in range(1, 3):
        v2 = 0.0
        for y in range(1, i):
            v2 += dst[y] * src[i - y]
        if val > 0.0:
            dst[i] = -(v2 + src[i]) / val
        else:
            dst[i] = 0.0
        tmp[i] = dst[i]
        for y in range(1, i):
            dst[y] += dst[i] * dst[i - y]
        val *= 1.0 - (dst[i] * dst[i])
    _finish_record(tmp, dst)


def _contrast_vectors(s1: list[float], s2: list[float]) -> float:
    val = (s2[2] * s2[1] + -s2[1]) / (1.0 - s2[2] * s2[2])
    val1 = (s1[0] * s1[0]) + (s1[1] * s1[1]) + (s1[2] * s1[2])
    val2 = (s1[0] * s1[1]) + (s1[1] * s1[2])
    val3 = s1[0] * s1[2]
    return val1 + (2.0 * val * val2) + (2.0 * (-s2[1] * val + -s2[2]) * val3)


def _filter_records(vec_best: list[list[float]], exp: int, records: list[list[float]]) -> None:
    for _ in range(2):
        buffer_list = [[0.0] * 3 for _ in range(exp)]
        buffer1 = [0] * exp

        for record in records:
            index = 0
            value = 1.0e30
            for i in range(exp):
                temp_val = _contrast_vectors(vec_best[i], record)
                if temp_val < value:
                    value = temp_val
                    index = i
            buffer1[index] += 1
            buffer2 = [0.0] * 3
            _matrix_filter(record, buffer2)
            for i in range(3):
                buffer_list[index][i] += buffer2[i]

        for i in range(exp):
            if buffer1[i] > 0:
                for y in range(3):
                    buffer_list[i][y] /= buffer1[i]

        for i in range(exp):
            _merge_finish_record(buffer_list[i], vec_best[i])


def dsp_correlate_coefs(source: list[int]) -> list[int]:
    """Compute the 8 DSP-ADPCM predictor coefficient pairs (16 s16 values)."""
    samples = len(source)
    records: list[list[float]] = []

    hist = [0] * 14  # previous frame's samples
    pcm_window = [0] * 28  # hist frame + current frame, contiguous

    pos = 0
    remaining = samples
    while remaining > 0:
        frame_samples = min(remaining, 0x3800)
        block = source[pos : pos + frame_samples]
        pos += frame_samples
        remaining -= frame_samples

        i = 0
        while i < frame_samples:
            pcm_window[:14] = hist
            for z in range(14):
                pcm_window[14 + z] = block[i + z] if i + z < len(block) else 0
            i += 14

            vec1 = _inner_product_merge(pcm_window, 14)
            if abs(vec1[0]) > 10.0:
                mtx = _outer_product_merge(pcm_window, 14)
                vec_idxs = [0, 0, 0]
                if not _analyze_ranges(mtx, vec_idxs):
                    _bidirectional_filter(mtx, vec_idxs, vec1)
                    if not _quadratic_merge(vec1):
                        rec = [0.0, 0.0, 0.0]
                        _finish_record(vec1, rec)
                        records.append(rec)

            hist = pcm_window[14:28]

    if not records:
        # Silence or degenerate input: trivial predictors.
        return [0] * 16

    vec_best = [[0.0] * 3 for _ in range(8)]

    vec1 = [1.0, 0.0, 0.0]
    for record in records:
        _matrix_filter(record, vec_best[0])
        for y in range(1, 3):
            vec1[y] += vec_best[0][y]
    for y in range(1, 3):
        vec1[y] /= len(records)
    _merge_finish_record(vec1, vec_best[0])

    exp = 1
    for w in range(3):
        vec2 = [0.0, -1.0, 0.0]
        for i in range(exp):
            for y in range(3):
                vec_best[exp + i][y] = (0.01 * vec2[y]) + vec_best[i][y]
        exp = 1 << (w + 1)
        _filter_records(vec_best, exp, records)

    coefs: list[int] = []
    for z in range(8):
        for k in (1, 2):
            d = -vec_best[z][k] * 2048.0
            if d > 0.0:
                v = 32767 if d > 32767.0 else int(round(d))
            else:
                v = -32768 if d < -32768.0 else int(round(d))
            coefs.append(v)
    return coefs


# ---------------------------------------------------------------------------
# DSP-ADPCM frame encoding (port of DSPEncodeFrame)
# ---------------------------------------------------------------------------


def _c_div(a: int, b: int) -> int:
    """C-style integer division (truncation toward zero)."""
    q = abs(a) // b
    return q if (a >= 0) == (b >= 0) else -q


def _encode_frame(pcm: list[int], sample_count: int, coefs: list[tuple[int, int]]) -> bytes:
    """Encode one frame. ``pcm`` holds [hist2, hist1, s0..s13]; decoded samples
    are written back into ``pcm`` so the next frame uses decoder-accurate
    history."""
    in_samples = [[0] * 16 for _ in range(8)]
    out_samples = [[0] * 14 for _ in range(8)]
    scale = [0] * 8
    dist_accum = [0.0] * 8

    for i in range(8):
        c0, c1 = coefs[i]
        ins = in_samples[i]
        outs = out_samples[i]
        ins[0] = pcm[0]
        ins[1] = pcm[1]

        distance = 0
        for s in range(sample_count):
            v1 = _c_div((pcm[s] * c1) + (pcm[s + 1] * c0), 2048)
            ins[s + 2] = v1
            v2 = pcm[s + 2] - v1
            v3 = 32767 if v2 >= 32767 else (-32768 if v2 <= -32768 else v2)
            if abs(v3) > abs(distance):
                distance = v3

        sc = 0
        while sc <= 12 and (distance > 7 or distance < -8):
            sc += 1
            distance = _c_div(distance, 2)
        sc = -1 if sc <= 1 else sc - 2

        while True:
            sc += 1
            dist_accum[i] = 0.0
            index = 0

            for s in range(sample_count):
                v1 = (ins[s] * c1) + (ins[s + 1] * c0)
                v2 = _c_div((pcm[s + 2] << 11) - v1, 2048)
                fv = v2 / (1 << sc)
                v3 = int(fv + 0.4999999) if v2 > 0 else int(fv - 0.4999999)

                if v3 < -8:
                    v3 = -8 - v3
                    if index < v3:
                        index = v3
                    v3 = -8
                elif v3 > 7:
                    v3 -= 7
                    if index < v3:
                        index = v3
                    v3 = 7

                outs[s] = v3

                v1 = (v1 + ((v3 * (1 << sc)) << 11) + 1024) >> 11
                v2 = 32767 if v1 >= 32767 else (-32768 if v1 <= -32768 else v1)
                ins[s + 2] = v2
                v3 = pcm[s + 2] - v2
                dist_accum[i] += v3 * float(v3)

            x = index + 8
            while x > 256:
                sc += 1
                if sc >= 12:
                    sc = 11
                x >>= 1

            if not (sc < 12 and index > 1):
                break

        scale[i] = sc

    best = 0
    vmin = dist_accum[0]
    for i in range(1, 8):
        if dist_accum[i] < vmin:
            vmin = dist_accum[i]
            best = i

    ins = in_samples[best]
    outs = out_samples[best]
    for s in range(sample_count):
        pcm[s + 2] = ins[s + 2]
    for s in range(sample_count, 14):
        outs[s] = 0

    out = bytearray(8)
    out[0] = ((best << 4) | (scale[best] & 0xF)) & 0xFF
    for y in range(7):
        out[y + 1] = ((outs[y * 2] << 4) | (outs[y * 2 + 1] & 0xF)) & 0xFF
    return bytes(out)


def dsp_encode(samples: list[int]) -> tuple[list[int], bytes]:
    """Encode a PCM16 channel to DSP-ADPCM. Returns (coefs[16], adpcm_bytes)."""
    coefs_flat = dsp_correlate_coefs(samples)
    coef_pairs = [(coefs_flat[i * 2], coefs_flat[i * 2 + 1]) for i in range(8)]

    num_frames = (len(samples) + _FRAME_SAMPLES - 1) // _FRAME_SAMPLES
    adpcm = bytearray()

    pcm_frame = [0] * 16  # [hist2, hist1, s0..s13]
    hist2 = 0
    hist1 = 0
    for f in range(num_frames):
        base = f * _FRAME_SAMPLES
        chunk = samples[base : base + _FRAME_SAMPLES]
        count = len(chunk)
        pcm_frame[0] = hist2
        pcm_frame[1] = hist1
        for z in range(_FRAME_SAMPLES):
            pcm_frame[z + 2] = chunk[z] if z < count else 0
        adpcm += _encode_frame(pcm_frame, count, coef_pairs)
        hist2 = pcm_frame[count]  # decoded, decoder-accurate history
        hist1 = pcm_frame[count + 1]

    return coefs_flat, bytes(adpcm)


# ---------------------------------------------------------------------------
# BWAV building
# ---------------------------------------------------------------------------


def _channel_pans(count: int) -> list[int]:
    if count == 1:
        return [2]
    if count == 2:
        return [0, 1]
    return [2] * count


def _align(value: int, alignment: int) -> int:
    return (value + alignment - 1) // alignment * alignment


def build_bwav(
    channels: list[list[int]],
    sample_rate: int,
    loop_start: int | None = None,
    loop_end: int | None = None,
) -> bytes:
    """Encode per-channel PCM16 to a complete (non-prefetch) DSP-ADPCM BWAV."""
    if not channels or not channels[0]:
        raise ValueError("No audio samples to encode")

    num_samples = len(channels[0])
    if any(len(c) != num_samples for c in channels):
        raise ValueError("All channels must have the same length")

    if loop_end is not None and loop_end > num_samples:
        loop_end = num_samples
    if loop_start is None or loop_end is None or loop_start >= loop_end:
        loop_start, loop_end = None, None

    encoded = [dsp_encode(list(c)) for c in channels]

    header_size = 0x10 + 0x4C * len(channels)
    data_start = _align(header_size, 0x40)

    offsets: list[int] = []
    pos = data_start
    for _, adpcm in encoded:
        offsets.append(pos)
        pos = _align(pos + len(adpcm), 0x40)

    crc = 0
    for _, adpcm in encoded:
        crc = zlib.crc32(adpcm, crc)

    pans = _channel_pans(len(channels))
    le = loop_end if loop_end is not None else -1
    ls = loop_start if loop_start is not None else 0

    total_size = offsets[-1] + len(encoded[-1][1])  # no trailing padding
    out = bytearray(total_size)
    struct.pack_into("<4sHHIHH", out, 0, _BWAV_MAGIC, 0xFEFF, 1, crc, 0, len(channels))
    for ci, (coefs, adpcm) in enumerate(encoded):
        o = 0x10 + ci * 0x4C
        struct.pack_into("<HHIII", out, o, 1, pans[ci], sample_rate, num_samples, num_samples)
        struct.pack_into("<16h", out, o + 0x10, *coefs)
        struct.pack_into("<IIIii", out, o + 0x30, offsets[ci], offsets[ci], 1, le, ls)
        struct.pack_into("<Hhh", out, o + 0x44, adpcm[0], 0, 0)
        # +0x4A padding already zero
        out[offsets[ci] : offsets[ci] + len(adpcm)] = adpcm
    return bytes(out)


def make_prefetch_bwav(full_bwav: bytes) -> bytes:
    """Build a prefetch clip (first 0x3800 samples per channel) from a full BWAV.

    The header (coefs, full sample count, CRC of the full data) is preserved;
    only the sample data is truncated at a frame boundary and the per-file
    fields are updated.
    """
    if full_bwav[:4] != _BWAV_MAGIC:
        raise ValueError("Not a BWAV file")

    channel_count = struct.unpack_from("<H", full_bwav, 0x0E)[0]
    if struct.unpack_from("<H", full_bwav, 0x10)[0] != 1:
        raise ValueError("Only DSP-ADPCM BWAVs can be turned into prefetch clips")
    header_size = 0x10 + 0x4C * channel_count

    out = bytearray(full_bwav[:header_size])
    struct.pack_into("<H", out, 0x0C, 1)  # prefetch flag

    chunks: list[bytes] = []
    offsets: list[int] = []
    pos = _align(header_size, 0x40)
    for ci in range(channel_count):
        o = 0x10 + ci * 0x4C
        ns_full = struct.unpack_from("<I", out, o + 8)[0]
        src_off = struct.unpack_from("<I", full_bwav, o + 0x34)[0]

        ns_file = min(ns_full, _PREFETCH_SAMPLES)
        frames = (ns_file + _FRAME_SAMPLES - 1) // _FRAME_SAMPLES
        nbytes = frames * _FRAME_BYTES

        struct.pack_into("<I", out, o + 0x0C, ns_file)
        struct.pack_into("<I", out, o + 0x34, pos)
        chunks.append(full_bwav[src_off : src_off + nbytes])
        offsets.append(pos)
        pos = _align(pos + nbytes, 0x40)

    result = bytearray(offsets[-1] + len(chunks[-1]))
    result[: len(out)] = out
    for off, chunk in zip(offsets, chunks):
        result[off : off + len(chunk)] = chunk
    return bytes(result)


def set_bwav_loop(bwav: bytes, loop_start: int | None, loop_end: int | None) -> bytes:
    """Return a copy of a BWAV with its loop points patched on every channel.

    ``loop_start=None`` clears the loop. ``loop_end`` is clamped to the sample
    count; pass a huge value to loop the whole clip.
    """
    if bwav[:4] != _BWAV_MAGIC:
        raise ValueError("Not a BWAV file")

    channel_count = struct.unpack_from("<H", bwav, 0x0E)[0]
    out = bytearray(bwav)
    for ci in range(channel_count):
        o = 0x10 + ci * 0x4C
        ns_full = struct.unpack_from("<I", out, o + 8)[0]
        ls = loop_start
        le = loop_end
        if le is not None and le > ns_full:
            le = ns_full
        if ls is None or le is None or ls >= le:
            ls, le = 0, -1
        struct.pack_into("<ii", out, o + 0x3C, le, ls)
    return bytes(out)


def find_ffmpeg() -> str | None:
    """Locate ffmpeg for decoding non-WAV audio (env override, then PATH)."""
    import shutil

    override = os.environ.get("TKVSC_FFMPEG", "").strip()
    if override and os.path.isfile(override):
        return override
    return shutil.which("ffmpeg")


def decode_audio_to_wav(payload: bytes, name_hint: str = "audio") -> bytes:
    """Decode any ffmpeg-supported audio (MP3, OGG, FLAC, M4A, ...) to a
    PCM16 WAV, preserving the source sample rate and channel count."""
    import subprocess
    import tempfile

    tool = find_ffmpeg()
    if tool is None:
        raise ValueError(
            "This audio format needs ffmpeg to decode. Install ffmpeg and make "
            "sure it is on PATH (or set TKVSC_FFMPEG to the executable), or "
            "supply a WAV/BWAV file instead."
        )

    suffix = Path(name_hint).suffix or ".bin"
    with tempfile.TemporaryDirectory(prefix="totk-audio-conv-") as tmp:
        inp = Path(tmp) / f"input{suffix}"
        out = Path(tmp) / "output.wav"
        inp.write_bytes(payload)
        result = subprocess.run(
            [tool, "-y", "-i", str(inp), "-map_metadata", "-1", "-c:a", "pcm_s16le", str(out)],
            capture_output=True,
        )
        if result.returncode != 0 or not out.is_file():
            stderr = (result.stderr or b"").decode(errors="replace")
            lines = [ln for ln in stderr.splitlines() if ln.strip() and not ln.startswith("  ")]
            detail = " | ".join(lines[-3:]) if lines else f"exit {result.returncode}"
            raise ValueError(f"ffmpeg failed to decode the audio: {detail}")
        return out.read_bytes()


def bwav_channel_count(bwav: bytes) -> int:
    if bwav[:4] != _BWAV_MAGIC:
        raise ValueError("Not a BWAV file")
    return struct.unpack_from("<H", bwav, 0x0E)[0]


def bwav_num_samples(bwav: bytes) -> int:
    if bwav[:4] != _BWAV_MAGIC:
        raise ValueError("Not a BWAV file")
    return struct.unpack_from("<I", bwav, 0x10 + 8)[0]


def bwav_is_prefetch(bwav: bytes) -> bool:
    return struct.unpack_from("<H", bwav, 0x0C)[0] != 0
