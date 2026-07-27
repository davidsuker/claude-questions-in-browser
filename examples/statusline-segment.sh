#!/bin/sh
# Example Claude Code status line showing an outstanding browser question.
#
# Register with `statusLine.command` in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "sh ~/.claude/statusline-command.sh" }
#
# The interesting part is the ask_seg block — lift that into your own status line script and
# keep whatever segments you already have. Requires `jq`.

input=$(cat)

session=$(echo "$input" | jq -r '.session_id // ""')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input" | jq -r '.model.display_name // ""')

block='\033[1;97;41m'
red='\033[1;31m'
cyan='\033[0;36m'
dim='\033[2m'
reset='\033[0m'

# --- Question-waiting segment -------------------------------------------------
# The AskUserQuestion browser hook writes this file while it blocks on an answer and removes
# it once the question is resolved, so a question that opened in a buried tab still announces
# itself here. Flags older than 15 minutes are ignored, in case a hook was killed before it
# could clean up.
#
# Rendered as a filled block rather than coloured text: this is the one segment worth
# interrupting for, and it has to win against a status line you have stopped reading.
ask_seg=""
ask_flag="/tmp/claude-ask-waiting-${session}"
if [ -n "$session" ] && [ -f "$ask_flag" ]; then
  if [ -z "$(find "$ask_flag" -mmin +15 2>/dev/null)" ]; then
    # First line is the URL, second is how many questions are waiting.
    ask_url=$(head -1 "$ask_flag")
    ask_n=$(sed -n '2p' "$ask_flag")
    case "$ask_n" in ''|*[!0-9]*) ask_n=1 ;; esac
    # One "?" per question, so the count reads at a glance: four questions = ????
    ask_marks=$(printf "%${ask_n}s" "" | tr ' ' '?')
    # How long it has been waiting, so a question you walked away from reads as stale.
    ask_age=$(( $(date +%s) - $(stat -f %m "$ask_flag" 2>/dev/null || echo 0) ))
    if [ "$ask_age" -ge 60 ]; then
      ask_for=$(printf "%dm" "$(( ask_age / 60 ))")
    else
      ask_for=$(printf "%ds" "$ask_age")
    fi
    ask_seg=$(printf "${block} %s ${reset}${red} %s ${reset}${dim}%s${reset}  " "$ask_marks" "$ask_url" "$ask_for")
  fi
fi
# ------------------------------------------------------------------------------

dir_seg=$(printf "${cyan}%s${reset}" "$cwd")
model_seg=$(printf "${dim}%s${reset}" "$model")

printf "%b%b  %b" "$ask_seg" "$dir_seg" "$model_seg"
