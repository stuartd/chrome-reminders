"""Create a Windows-friendly unpacked-extension ZIP using only Python's stdlib."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
output = root / 'dist' / 'meeting-reminders.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in sorted((root / 'extension').rglob('*')):
        if path.is_file() and not path.name.startswith('.'):
            archive.write(path, path.relative_to(root).as_posix())
    archive.write(root / 'README.md', 'README.md')
with ZipFile(output) as archive:
    assert archive.testzip() is None
print(output)
