#!/bin/bash
# Releases go through the "Release x.y.z" pull request that release-please keeps open
# on GitHub: merging it tags vX.Y.Z, and .github/workflows/publish.yml publishes to npm
# after CI passes and a maintainer approves the `npm` environment. See README "Releasing".
#
# Usage: ./publish.sh --local [patch|minor|major]
#   --local  emergency path: bump, tag and publish directly from this machine (npm web
#            auth), then push the tag, the GitHub release and the commit.
set -e

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
echo "Publishing to npm from this machine..."
if ! npm publish --auth-type=web; then
    echo "Error: npm publish failed. v$VERSION is committed and tagged locally but not"
    echo "pushed. Retry npm publish --auth-type=web, then push by hand:"
    echo "  git push origin v$VERSION"
    echo "  gh release create v$VERSION --verify-tag --generate-notes && git push"
    exit 1
fi

# The GitHub release tells release-please where this release starts; create it
# before pushing main so the Release PR run on that push already sees it.
echo "Pushing the tag, the GitHub release and main..."
git push origin "v$VERSION"
gh release create "v$VERSION" --verify-tag --generate-notes --title "v$VERSION" \
    || echo "Warning: create the GitHub release by hand: gh release create v$VERSION --verify-tag"
git push
echo "Done! Published v$VERSION"
