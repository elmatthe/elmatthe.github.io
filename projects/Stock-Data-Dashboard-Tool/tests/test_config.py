from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from config import ensure_directory, get_exports_dir, get_plots_dir, get_website_assets_dir  # noqa: E402


def temp_config_dir(name: str) -> Path:
    path = Path(__file__).resolve().parents[1] / ".run-temp" / name
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path


def test_ensure_directory_creates_missing_folder():
    target = temp_config_dir("config-dir") / "new-export-folder"
    created = ensure_directory(target)
    assert created.exists()
    assert created.is_dir()


def test_project_output_directories_exist():
    assert get_exports_dir().is_dir()
    assert get_plots_dir().is_dir()
    assert get_website_assets_dir().is_dir()
