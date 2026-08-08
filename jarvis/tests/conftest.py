import sys
from pathlib import Path

# Allow `import backend...` when running pytest from the jarvis/ directory
# without requiring the package to be installed.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
