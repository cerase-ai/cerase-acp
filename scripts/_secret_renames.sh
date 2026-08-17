# shellcheck shell=bash
#
# A0 step 3 — the credential renames, as DATA.
#
# ── Why a file and not a sed somebody ran once ──
#
# Four things consume this list and they must not be able to disagree:
#
#   `_load_env.sh`     dies when it reads an old spelling, so nothing loads a
#                      value under a name the code no longer looks for
#   `cli.sh update`    converges the appliance's own /opt/cerase/.env (step 2b)
#   the G3 guard       fails CI on any surviving old spelling, in every repo
#   `gen-secrets.sh`   the manifest and the generated example
#
# A rename applied by hand in four places is a rename that is complete in three.
#
# ── Why a HARD cutover, with no compatibility shim ──
#
# A shim is code written to be deleted later, and later does not come. At this
# size — one operator, two machines, one plane — a loud failure costs minutes
# and leaves no debt. So `_load_env_file` DIES naming the new spelling rather
# than quietly accepting both.
#
# The one thing that makes this safe is that the appliances move first.
# `/opt/cerase/.env` on every live box carries these names, and
# `deploy/backup.sh` reads an unset passphrase as "no encryption requested"
# and writes an unencrypted archive with a warning. A cutover in the code
# alone would not fail loudly there — it would quietly stop encrypting.
# That is why step 2b exists and why it ships in the same release.
#
# ── What is NOT renamed, and the list is as load-bearing as the renames ──
#
# `AWS_*`, `HCLOUD_TOKEN`, `MAIL_*`, `DB_*`, `APP_*`, `CERASE_TFSTATE_CONN`,
# `CERASE_GHCR_*`, `CERASE_MAIL_RELAY_*`. A third-party tool reads its own
# variable under a name it chose; renaming those would mean setting two.

# old<TAB>new, one per line. `CERASE_` prefixes what is OURS.
#
# The FLEET_-prefixed duplicates are on the left too. They are the same value
# under a second spelling in the same file — the exact drift this milestone
# removes, and leaving them out would let a reader keep finding the value under
# a name nothing else writes.
_CERASE_SECRET_RENAMES='
HCLOUD_SSH_KEY_ID	CERASE_HCLOUD_SSH_KEY_ID
FLEET_HCLOUD_SSH_KEY_ID	CERASE_HCLOUD_SSH_KEY_ID
ROUTE53_HOSTED_ZONE_ID	CERASE_ROUTE53_ZONE_TENANTS
FLEET_ROUTE53_ZONE_ID	CERASE_ROUTE53_ZONE_TENANTS
ROUTE53_ZONE_CERASE_EMAIL	CERASE_ROUTE53_ZONE_MAIL
FLEET_ROUTE53_ZONE_CERASE_EMAIL	CERASE_ROUTE53_ZONE_MAIL
OPENROUTER_PROVISIONING_KEY	CERASE_OPENROUTER_MGMT_KEY
OPENROUTER_WORKSPACE_ID	CERASE_OPENROUTER_WORKSPACE_ID
BACKUP_S3_ENDPOINT	CERASE_BACKUP_S3_ENDPOINT
BACKUP_S3_ACCESS_KEY	CERASE_BACKUP_S3_ACCESS_KEY
BACKUP_S3_SECRET_KEY	CERASE_BACKUP_S3_SECRET_KEY
BACKUP_S3_BUCKET	CERASE_BACKUP_S3_BUCKET
BACKUP_COLD_S3_BUCKET	CERASE_BACKUP_COLD_S3_BUCKET
BACKUP_COLD_S3_ENDPOINT	CERASE_BACKUP_COLD_S3_ENDPOINT
BACKUP_COLD_S3_ACCESS_KEY	CERASE_BACKUP_COLD_S3_ACCESS_KEY
BACKUP_COLD_S3_SECRET_KEY	CERASE_BACKUP_COLD_S3_SECRET_KEY
BACKUP_ENCRYPTION_PASSPHRASE	CERASE_BACKUP_PASSPHRASE
MARKETPLACE_ADMIN_EMAIL	CERASE_MARKETPLACE_ADMIN_EMAIL
MARKETPLACE_ADMIN_PASSWORD	CERASE_MARKETPLACE_ADMIN_PASSWORD
DASH_ADMIN_EMAIL	CERASE_DASH_ADMIN_EMAIL
DASH_ADMIN_PASSWORD	CERASE_DASH_ADMIN_PASSWORD
SCALEWAY_ACCESS_KEY	CERASE_SCALEWAY_ACCESS_KEY
SCALEWAY_SECRET_KEY	CERASE_SCALEWAY_SECRET_KEY
SCALEWAY_PROJECT_ID	CERASE_SCALEWAY_PROJECT_ID
OPENCODE_VERSION	CERASE_AGENT_VERSION
'

# ── The one row here that is not a credential, and why it belongs anyway ──
#
# `OPENCODE_VERSION` named two unrelated things in two files. In
# `agent-runtime/slot/opencode.pin` it is the opencode RELEASE the slot image
# bakes, carried with the sha256 of that exact artifact and refused by the build
# without it. In `.env` it was the GHCR TAG of the slot image, normally
# `latest`, and nothing connected the two.
#
# A reader meets `.env` first. It said `latest`, so the honest conclusion from
# it -- reached and reported by a careful reader -- was that the opencode
# version is pinned nowhere. It is pinned, with a digest, in the file they had
# no reason to open. The conclusion the collision produces is the reassuring
# direction of wrong, which is the direction that does not get checked.
#
# So the `.env` copy takes the name every other image tag in this file already
# uses, `CERASE_AGENT_VERSION`, beside `CERASE_ACP_VERSION` and
# `CERASE_CONTROL_PLANE_VERSION`. `OPENCODE_VERSION` keeps its one real meaning
# in the pin file, where the digest beside it says what it is.
#
# It rides this table rather than a one-off sed for the reason the header gives:
# the four consumers must not be able to disagree, and an operator's live `.env`
# has to be migrated by the tool rather than by hand. The two properties that
# matter here are the same two the credentials get -- `_load_env_file` dies on
# the old spelling, and `_converge_secret_names` rewrites an existing file in
# place before anything reads it.

# Every OLD spelling, one per line.
_cerase_rename_old_names() {
    printf '%s' "$_CERASE_SECRET_RENAMES" | awk -F'\t' 'NF==2 {print $1}'
}

# Every NEW spelling, deduplicated — two old names can map to one new one.
_cerase_rename_new_names() {
    printf '%s' "$_CERASE_SECRET_RENAMES" | awk -F'\t' 'NF==2 {print $2}' | sort -u
}

# The new spelling for one old name, or empty.
_cerase_rename_for() {   # <old-name>
    printf '%s' "$_CERASE_SECRET_RENAMES" \
        | awk -F'\t' -v k="$1" 'NF==2 && $1==k {print $2; exit}'
}

# ─── A0 step 2b — converge a .env to the new spellings ───────────
#
# `_load_env_file` DIES on a retired name (A0 step 3, hard cutover, no shim), and
# the thing that fixes a retired name is this script. So the converge runs FIRST,
# before anything reads the file — otherwise every verb on an un-migrated box
# dies telling the operator to run a verb that also dies.
#
# Why an appliance cannot be left to a human edit. `/opt/cerase/.env` on
# every live box carries the RETIRED spelling of the backup passphrase —
# named by the table above rather than written here, because this sentence
# would be mechanically rewritten by the very rename it describes and come
# out claiming the opposite. `deploy/backup.sh` reads an unset passphrase
# as "no encryption requested" — it writes an unencrypted archive with a
# warning and exits 0. A rename shipped in the code alone would not fail
# on those boxes; it would quietly stop encrypting them, and the first
# anyone would know is an unencrypted archive in a bucket.
#
# Silent when there is nothing to do, so it is not a side effect on
# `./cli.sh logs`. It rewrites only when an old name is actually present, says
# so once, and keeps a timestamped copy — a script that edits a file holding
# every credential on the machine leaves the previous version behind.
_converge_secret_names() {   # <env-file>
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] && [ -w "$f" ] || return 0
  [ -n "${_CERASE_SECRET_RENAMES:-}" ] || return 0

  local old new hits=0 sedargs=()
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    # Anchored at the start of a line and followed by `=`: a VALUE mentioning
    # the old name (a comment, a URL) is not a key and must not be rewritten.
    grep -q "^${old}=" "$f" || continue
    new="$(_cerase_rename_for "$old")"
    [ -n "$new" ] || continue
    sedargs+=(-e "s|^${old}=|${new}=|")
    hits=$((hits + 1))
  done < <(_cerase_rename_old_names)

  [ "$hits" -gt 0 ] || return 0

  # The SAME naming convention `_secrets.sh` uses for every other copy of an
  # env file, and for the same reason: `.bak-secret-<stamp>` is the pattern its
  # prune recognises, so this copy ages out with the rest instead of becoming
  # the thing the G2 guard was written to catch — an UNMANAGED duplicate of a
  # credential file that nobody removes. Inventing a second suffix here would
  # make the converge produce, on every run, exactly the defect the guard
  # exists to catch.
  local bak
  bak="${f}.bak-secret-$(date -u +%Y%m%d%H%M%S)"
  cp -p "$f" "$bak" && chmod 600 "$bak"
  sed -i "${sedargs[@]}" "$f"
  # `if`, not `A && B || C`: under `set -e` a function whose last statement is
  # a failing test returns 1 in the NORMAL case. Here it would also run the
  # fallback when the prune merely found nothing to remove.
  if command -v _secret_backup_prune >/dev/null 2>&1; then
    _secret_backup_prune "$f" || true
  fi
  printf '\033[0;33m⚠\033[0m %s: renamed %d retired credential name(s) to the CERASE_ spelling (A0).\n' "$f" "$hits" >&2
  printf '  Previous version kept at %s (0600), pruned with the other env backups.\n' "$bak" >&2
}

