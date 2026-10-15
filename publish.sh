#!/bin/bash
# Release: bump the version, push the commit and tag. The tag push triggers
# .github/workflows/publish.yml, which tests and stages the version on npm via
# Trusted Publishing (OIDC); a maintainer then approves it on npmjs.com (2FA).
# Usage: ./publish.sh [patch|minor|major] [--local]
#   --local  fallback: publish directly from this machine (npm web auth), as before.
set -e

# Ensure we're in the project directory
cd "$(dirname "$0")"

LOCAL=false
VERSION_TYPE="patch"
for arg in "$@"; do
    case "$arg" in
        --local) LOCAL=true ;;
        *) VERSION_TYPE="$arg" ;;
    esac
done

# Publish from main only: npm version commits and tags the *current* branch.
if [[ "$(git branch --show-current)" != "main" ]]; then
    echo "Error: publish.sh must run on main (currently on '$(git branch --show-current)')."
    exit 1
fi

# Check for uncommitted changes. Refresh the index first so files whose stat info
# changed (e.g. touched by a build) but whose content did not aren't reported.
git update-index -q --refresh
if ! git diff-index --quiet HEAD --; then
    echo "Error: You have uncommitted changes. Commit them first."
    exit 1
fi

echo "Building..."
npm run build
git update-index -q --refresh
if ! git diff-index --quiet HEAD -- dist; then
    echo "Error: the build changed dist/. Commit the rebuilt dist first."
    exit 1
fi

echo "Bumping version ($VERSION_TYPE)..."
npm version "$VERSION_TYPE"
VERSION=$(node -p "require('./package.json').version")

echo "Pushing to git..."
git push && git push --tags

if [[ "$LOCAL" == true ]]; then
    echo "Publishing to npm from this machine..."
    npm publish --auth-type=web
    echo "Done! Published v$VERSION"
    exit 0
fi

APPROVE_URL="https://www.npmjs.com/package/claude-code-infinite"
echo "Pushed v$VERSION. It is staged by CI after tests pass; approve it at"
echo "  $APPROVE_URL (Staged Packages tab), or: npm stage approve <stage-id>"
sleep 5
RUN_URL=$(gh run list --workflow publish.yml -L1 --json url --jq '.[0].url' 2>/dev/null || true)
if [[ -n "$RUN_URL" ]]; then
    echo "Actions run: $RUN_URL"
else
    echo "Actions runs: https://github.com/crizCraig/claude-code-infinite/actions/workflows/publish.yml"
fi
