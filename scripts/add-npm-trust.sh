#!/usr/bin/env bash
set -euo pipefail

registry=https://registry.npmjs.org/
repository=atlassian-labs/npm-publisher
workflow=publish-npm.yml
environment=prod

usage() {
  printf 'Usage: %s [package-name ...] [--dry-run]\n' "$0"
  printf 'With no package names, read .github/scripts/oidc-packages.txt (one package per line).\n'
  printf 'Dry-run checks existing trust and requires an existing npm login.\n'
  printf 'Dist-tag permission must be enabled separately in npm package settings.\n'
}

package_arguments=()
dry_run=false
for argument in "$@"; do
  case "$argument" in
    --help|-h) usage; exit 0 ;;
    --dry-run) dry_run=true ;;
    ''|-*) usage >&2; exit 1 ;;
    *) package_arguments+=("$argument") ;;
  esac
done
if (( ${#package_arguments[@]} > 0 )); then
  packages=("${package_arguments[@]}")
else
  packages=()
  packages_file="$(dirname "${BASH_SOURCE[0]}")/../.github/scripts/oidc-packages.txt"
  while IFS= read -r package_name || [[ -n "$package_name" ]]; do
    if [[ -n "$package_name" ]]; then packages+=("$package_name"); fi
  done < "$packages_file"
  if (( ${#packages[@]} == 0 )); then
    printf 'No packages found in %s\n' "$packages_file" >&2
    exit 1
  fi
fi

if ! command -v jq >/dev/null; then
  printf 'jq is required to read npm trust configurations.\n' >&2
  exit 1
fi

trust_output=$(mktemp "${TMPDIR:-/tmp}/npm-trust.XXXXXX")
trap 'rm -f -- "$trust_output"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# npm trust requires a logged-in account before its confirmation and 2FA prompts.
if ! "$dry_run" && ! npm whoami --registry="$registry" >/dev/null 2>&1; then
  printf 'Log in to npm before configuring trusted publishing.\n'
  npm login --registry="$registry" --auth-type=web
fi

trust_arguments=(
  --registry="$registry"
  --repository="$repository"
  --environment="$environment"
  --file="$workflow"
  --allow-publish
  --yes
)
if "$dry_run"; then trust_arguments+=(--dry-run); fi

for index in "${!packages[@]}"; do
  # npm recommends spacing bulk trust operations to avoid rate limiting.
  if (( index > 0 )); then sleep 2; fi
  package_name=${packages[$index]}
  printf 'Checking trusted publisher for %s\n' "$package_name"
  # macOS script preserves terminal access for npm's browser/2FA prompts.
  # Disable the spinner: its terminal control codes obscure JSON boundaries.
  script -q "$trust_output" npm trust list "$package_name" --registry="$registry" --json --color=false --progress=false
  # Keep the pretty-printed JSON objects, excluding terminal prompts and notices.
  trust_exists=$(sed -n '/^{/,/^}/p' "$trust_output" |
    jq -s --arg repository "$repository" --arg workflow "$workflow" --arg environment "$environment" '
      any(.[]; .type == "github" and .repository == $repository and
        .file == $workflow and .environment == $environment)
    ')

  # The CLI omits validation status, so keep matching trusts, including pending ones.
  if [[ "$trust_exists" == true ]]; then
    printf 'Skipping %s: matching trusted publisher already exists.\n' "$package_name"
  else
    npm trust github "$package_name" "${trust_arguments[@]}"
  fi

  # npm trust has no CLI flag to grant dist-tag permission.
  printf '\nManual step: enable "Allow npm dist-tag" for %s / %s / %s.\n' "$repository" "$workflow" "$environment"
  printf 'Package settings: https://www.npmjs.com/package/%s/access\n' "$package_name"
done
