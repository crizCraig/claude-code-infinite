#!/bin/bash
# Releases go through the "Release x.y.z" pull request that release-please keeps open
# on GitHub: merging it tags vX.Y.Z, and .github/workflows/publish.yml publishes to npm
# after CI passes and a maintainer approves the `npm` environment. See README "Releasing".
#
# Usage: ./publish.sh --local [patch|minor|major]
#   --local  emergency path: bump, tag and publish directly from this machine (npm web
#            auth), then push the commit and tag (atomically) and create the GitHub release.
set -euo pipefail

REPO_URL="https://github.com/crizCraig/claude-code-infinite"

# Ensure we're in the project directory
cd "$(dirname "$0")"

LOCAL=false
VERSION_TYPE="patch"
for arg in "$@"; do
    case "$arg" in
        --local) LOCAL=true ;;
        patch|minor|major) VERSION_TYPE="$arg" ;;
        *) echo "Error: unknown argument '$arg'."; exit 1 ;;
    esac
done

if [[ "$LOCAL" != true ]]; then
    echo "Releases now go through the Release PR, not this script:"
    echo "  1. Merge the open \"Release x.y.z\" pull request: $REPO_URL/pulls"
    echo "  2. Approve the 'npm' environment when publish.yml asks (GitHub app or"
    echo "     $REPO_URL/actions/workflows/publish.yml)."
    echo "Emergency only: ./publish.sh --local [patch|minor|major] publishes from this machine."
    exit 1
fi

# Publish from main only: the release commit and tag go on the *current* branch.
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

# Release only what is on origin/main: publish.yml rejects a tag whose commit is not on
# main, and a stale main would make the final push fail after npm already has the version.
git fetch -q origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    echo "Error: local main differs from origin/main. Pull (or push) first."
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
npm version "$VERSION_TYPE" --no-git-tag-version > /dev/null
VERSION=$(node -p "require('./package.json').version")
# Keep release-please's manifest in step, or its next Release PR repeats this version.
node -e '
  const fs = require("fs");
  const f = ".release-please-manifest.json";
  const m = JSON.parse(fs.readFileSync(f, "utf8"));
  m["."] = process.argv[1];
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");
' "$VERSION"
git add package.json package-lock.json .release-please-manifest.json
git commit -m "Release $VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

# Publish before pushing the tag: the tag push runs publish.yml, which sees this
# version already on npm and only tests it instead of racing us for it.
PUSH_HELP="git push --atomic origin main v$VERSION && gh release create v$VERSION --verify-tag --generate-notes"
echo "Publishing to npm from this machine..."
if ! npm publish --auth-type=web; then
    echo "Error: npm publish failed. v$VERSION is committed and tagged locally but not"
    echo "pushed. Retry npm publish --auth-type=web, then: $PUSH_HELP"
    exit 1
fi

# One atomic push, so the tag never exists on GitHub without its commit on main.
echo "Pushing main and v$VERSION..."
if ! git push --atomic origin main "v$VERSION"; then
    echo "Error: v$VERSION is on npm but the push failed. Fix the remote state (the tag names"
    echo "this commit, so do not rebase it), then: $PUSH_HELP"
    exit 1
fi
# The GitHub release tells release-please where this release starts.
if ! gh release create "v$VERSION" --verify-tag --generate-notes --title "v$VERSION"; then
    echo "Error: create the GitHub release by hand, or release-please's next PR will"
    echo "repeat this release's commits: gh release create v$VERSION --verify-tag --generate-notes"
    exit 1
fi
echo "Done! Published v$VERSION"
