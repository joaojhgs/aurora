#!/usr/bin/env zsh
# Script to run linting with autofix on staged files

# Ensure we're in the repository root directory
SCRIPT_DIR=$(dirname "$0")
cd "$SCRIPT_DIR/.." || { echo "❌ Could not navigate to repository root"; exit 1; }

# Check if pre-commit is installed
if ! command -v pre-commit &> /dev/null; then
    echo "❌ pre-commit is not installed. Installing now..."
    pip install pre-commit
fi

# Check if git repository exists
if [ ! -d .git ]; then
    echo "❌ Not a git repository. Run 'git init' first."
    exit 1
fi

# Install pre-commit hooks if not already installed
if [ ! -f .git/hooks/pre-commit ]; then
    echo "📝 Installing pre-commit hooks..."
    pre-commit install
fi

# Get staged files
STAGED_FILES=$(git diff --cached --name-only)

# Check if there are staged files
if [ -z "$STAGED_FILES" ]; then
    echo "⚠️ No files are staged for commit. Stage files first with 'git add'."
    echo "   To run on all files, use: pre-commit run --all-files"
    exit 0
fi

# Run pre-commit on staged files
echo "🔍 Running pre-commit on staged files..."
pre-commit run --files $STAGED_FILES

exit_code=$?
if [ $exit_code -eq 0 ]; then
    echo "✅ All checks passed! You can now commit your changes."
else
    echo "⚠️  Some issues were found and may have been automatically fixed."
    echo "   Please review the changes, then stage and commit again."
fi

exit $exit_code
