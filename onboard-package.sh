#!/usr/bin/env bash
set -euo pipefail

usage="Usage: bash ${BASH_SOURCE[0]} <package-directory>"
if [[ ${1:-} == --help ]]; then
  printf '%s\n' "$usage"
  exit 0
fi
if [[ $# -ne 1 ]]; then
  printf '%s\n' "$usage" >&2
  exit 1
fi

package_directory=$(cd -- "$1" && pwd -P)
# Node is already required by npm; use it only to read and validate JSON.
metadata=$(node --input-type=commonjs -e '
  const pkg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name || "") ||
      !pkg.version || pkg.private) {
    console.error("The package needs a valid name and version; private: true prevents publication.");
    process.exit(1);
  }
  if (pkg.publishConfig?.access !== undefined && pkg.publishConfig.access !== "public") {
    console.error("This workflow publishes public packages only. Refusing to override publishConfig.access.");
    process.exit(1);
  }
  console.log(`${pkg.name}\t${pkg.version}`);
' "$package_directory/package.json")
IFS=$'\t' read -r package_name package_version <<< "$metadata"

registry=https://registry.npmjs.org/
repository=atlassian-labs/artifactory-npm-publisher
scope='(none)'
if [[ $package_name == @*/* ]]; then
  scope=${package_name%%/*}
fi
printf 'Package: %s\nScope: %s\nVersion: %s\nVisibility: public\nRegistry: %s\n' \
  "$package_name" "$scope" "$package_version" "$registry"
printf 'Publish this package? [y/N]: '
IFS= read -r confirmation || confirmation=
case "$confirmation" in
  [yY]|[yY][eE][sS]) ;;
  *) printf '%s\n' 'Cancelled. Nothing was published.'; exit 1 ;;
esac

# Do not inherit another npm session or project registry configuration.
shopt -s nocasematch
while IFS= read -r variable; do
  case "$variable" in npm_*|node_auth_token) unset "$variable" ;; esac
done < <(compgen -e)
shopt -u nocasematch

umask 077
temporary=$(mktemp -d "${TMPDIR:-/tmp}/npm-onboard.XXXXXX")
userconfig=$temporary/user.npmrc
child_pid=
published=0
trusted=0
npm_options=(
  "--registry=$registry" "--userconfig=$userconfig"
  "--globalconfig=$temporary/global.npmrc" "--prefix=$temporary"
  "--cache=$temporary/cache" --logs-max=0
)

run_npm() {
  local status=0
  # Explicit stdin keeps browser/2FA prompts interactive while wait allows traps.
  command npm "$@" "${npm_options[@]}" <&0 &
  child_pid=$!
  wait "$child_pid" || status=$?
  child_pid=
  return "$status"
}

interrupt() {
  trap '' INT TERM
  if [[ -n $child_pid ]]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
    child_pid=
  fi
  exit "$1"
}

cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM
  set +e
  if [[ $published == 1 && $trusted == 0 ]]; then
    printf '%s\n' 'The version is published. Configure trust separately; do not republish the same version.' >&2
  fi
  if [[ -s $userconfig ]]; then
    printf '%s\n' 'Revoking the temporary npm login...'
    if ! run_npm logout --fetch-retries=0 --fetch-timeout=15000; then
      printf '%s\n' 'npm logout failed: server-side token revocation is unconfirmed. Revoke the session in npm account settings.' >&2
      status=1
    fi
  fi
  rm -rf -- "$temporary" || status=1
  if [[ $status == 0 ]]; then
    printf '%s\n' 'Published, trusted publisher configured, and temporary login removed.'
    printf 'Manual step required for %s: enable Allow npm dist-tag in npm trusted publisher settings.\n' "$package_name"
    printf '%s\n' 'Use publish-npm.yml with environment npmjs-prod; keep Allow npm publish enabled.'
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

: > "$userconfig"
: > "$temporary/global.npmrc"
cd -- "$temporary"
npm_version=$(run_npm --version)
if [[ ! $npm_version =~ ^([0-9]+)\.([0-9]+)\. ]] ||
   (( BASH_REMATCH[1] < 11 || (BASH_REMATCH[1] == 11 && BASH_REMATCH[2] < 15) )); then
  printf '%s\n' 'npm 11.15.0 or later is required for npm trust.' >&2
  exit 1
fi

printf 'Publishing %s@%s publicly; trusting %s.\n' "$package_name" "$package_version" "$repository"
run_npm login --auth-type=web

run_npm profile get name 'two-factor auth' --fetch-retries=0 --fetch-timeout=15000 > "$temporary/account-status"
IFS=$'\t' read -r account_name two_factor < "$temporary/account-status"
printf 'npm account: %s\nAccount 2FA: %s\n' "$account_name" "$two_factor"
case "$two_factor" in
  auth-only|auth-and-writes) ;;
  disabled)
    printf '%s\n' 'Publishing requires account 2FA. Enable it in npm Account > Two-Factor Authentication, then rerun this script.' >&2
    exit 1 ;;
  *)
    printf '%s\n' 'Could not verify account 2FA. Check the signed-in npm account before publishing.' >&2
    exit 1 ;;
esac

# Build first: lifecycle scripts must not run with the temporary login token.
publish_args=(publish "$package_directory" --access=public --ignore-scripts)
if [[ $package_name == @*/* ]]; then
  publish_args+=("--${package_name%%/*}:registry=$registry")
fi
run_npm "${publish_args[@]}"
published=1
run_npm trust github "$package_name" \
  "--repository=$repository" --file=publish-npm.yml \
  --environment=npmjs-prod --allow-publish --yes
trusted=1
