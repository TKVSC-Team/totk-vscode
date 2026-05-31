import sys
from PIL import Image

def check():
    img = Image.open(r"C:\Users\Aiden\AppData\Local\Temp\totk-txtg-46ue49e_-Armor_001_Lower_Alb.1.png")
    pixels = img.load()
    w, h = img.size
    
    # Check last 10 columns for transparency
    for x in range(w - 20, w):
        transparent = True
        for y in range(h):
            if img.mode == 'RGBA':
                if pixels[x, y][3] > 0:
                    transparent = False
                    break
        if transparent:
            print(f"Column {x} is fully transparent!")
        else:
            print(f"Column {x} has data.")

if __name__ == "__main__":
    check()
