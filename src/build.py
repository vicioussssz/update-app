import pathlib, re

root = pathlib.Path(__file__).resolve().parent
out_dir = root.parent if (root.name == "src") else root

html = (root / "template.html").read_text()

repl = {
    "__ICON180__": (root / "icon180.b64").read_text().strip(),
    "__ICON512__": (root / "icon512.b64").read_text().strip(),
    "__SB_URL__":  "https://mxncjgxpgsilepojwttb.supabase.co",
    "__SB_KEY__":  "sb_publishable_N53SPrcpCaC8B7HtH30Njg_120kFg5g",
}
for k, v in repl.items():
    html = html.replace(k, v)

left = re.findall(r"__[A-Z0-9_]+__", html)
assert not left, f"unreplaced placeholders: {set(left)}"

out = out_dir / "index.html"
out.write_text(html)
print("wrote", out, f"{out.stat().st_size/1024:.1f} KB")
