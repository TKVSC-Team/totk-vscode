import yaml

config_path = "../vendor/TotK.gcf"
with open(config_path, "r", encoding="utf-8") as f:
    data = yaml.safe_load(f)

tags = data["msbt"]["tags"]
by_group_type = {}
by_name = {}

for t in tags:
    key = f"{t['group']}_{t['type']}"
    by_group_type[key] = t
    by_name[t["name"]] = t

with open("msbt_tags.py", "w", encoding="utf-8") as out:
    out.write("MSBT_TAGS_BY_ID = " + repr(by_group_type) + "\n")
    out.write("MSBT_TAGS_BY_NAME = " + repr(by_name) + "\n")
