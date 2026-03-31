#!/usr/bin/env bash
# video-evaluator.sh — Evaluate video files against configurable quality criteria
# Usage: ./video-evaluator.sh [OPTIONS] <video_file|directory>

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config/criteria.conf"
OUTPUT_FORMAT="text"   # text | json | csv
VERBOSE=false
RECURSIVE=false
REPORT_FILE=""

# ── Evaluation results ────────────────────────────────────────────────────────
TOTAL_FILES=0
PASSED_FILES=0
FAILED_FILES=0
declare -a RESULTS=()

# ── Colors ─────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; RESET=''
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
log()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
warn()   { echo -e "${YELLOW}[WARN]${RESET}  $*" >&2; }
error()  { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()    { error "$*"; exit 1; }

usage() {
  cat <<EOF
${BOLD}Usage:${RESET}
  $(basename "$0") [OPTIONS] <video_file|directory>

${BOLD}Options:${RESET}
  -c <file>    Path to criteria config file (default: config/criteria.conf)
  -f <format>  Output format: text (default), json, csv
  -o <file>    Write report to file instead of stdout
  -r           Recurse into subdirectories
  -v           Verbose output (show all criteria details)
  -h           Show this help message

${BOLD}Examples:${RESET}
  $(basename "$0") lecture.mp4
  $(basename "$0") -v -f json submissions/
  $(basename "$0") -r -c my_criteria.conf -o report.txt videos/
EOF
  exit 0
}

# ── Dependency check ──────────────────────────────────────────────────────────
check_deps() {
  local missing=()
  for cmd in ffprobe bc; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required dependencies: ${missing[*]}\nInstall with: sudo apt-get install ffmpeg bc"
  fi
}

# ── Config loading ─────────────────────────────────────────────────────────────
load_config() {
  # Defaults (can be overridden by config file)
  MIN_DURATION_SEC=30
  MAX_DURATION_SEC=3600
  MIN_WIDTH=640
  MIN_HEIGHT=360
  MAX_WIDTH=3840
  MAX_HEIGHT=2160
  MIN_VIDEO_BITRATE_KBPS=200
  MAX_VIDEO_BITRATE_KBPS=50000
  MIN_FPS=15
  MAX_FPS=120
  ALLOWED_VIDEO_CODECS="h264 hevc vp8 vp9 av1"
  REQUIRE_AUDIO=true
  ALLOWED_AUDIO_CODECS="aac mp3 opus vorbis flac pcm_s16le pcm_s24le"
  MIN_AUDIO_SAMPLE_RATE=22050
  MIN_AUDIO_CHANNELS=1
  ALLOWED_CONTAINERS="mp4 mkv webm mov avi"
  MAX_FILE_SIZE_MB=0   # 0 = no limit

  [[ -f "$CONFIG_FILE" ]] || return 0

  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
  $VERBOSE && log "Loaded config from $CONFIG_FILE"
}

# ── ffprobe helpers ───────────────────────────────────────────────────────────
probe_value() {
  local file="$1" stream="$2" key="$3"
  ffprobe -v quiet -select_streams "$stream" \
    -show_entries "stream=${key}" -of csv=p=0 "$file" 2>/dev/null | head -1
}

probe_format() {
  local file="$1" key="$2"
  ffprobe -v quiet -show_entries "format=${key}" -of csv=p=0 "$file" 2>/dev/null | head -1
}

# ── Per-criterion check ───────────────────────────────────────────────────────
# Prints "PASS|FAIL <criterion>: <message>"
check() {
  local status="$1" name="$2" msg="$3"
  if [[ "$status" == "pass" ]]; then
    echo "PASS|${name}|${msg}"
  else
    echo "FAIL|${name}|${msg}"
  fi
}

# ── Single file evaluation ────────────────────────────────────────────────────
evaluate_file() {
  local file="$1"
  local checks=()
  local file_passed=true

  # ── Extract metadata ──────────────────────────────────────────────────────
  local container duration_raw width height \
        v_codec v_bitrate_raw fps_raw \
        a_codec a_sample_rate a_channels \
        file_size_mb

  container=$(ffprobe -v quiet -show_entries format=format_name -of csv=p=0 "$file" 2>/dev/null | cut -d, -f1)
  duration_raw=$(probe_format "$file" duration)
  width=$(probe_value "$file" "v:0" width)
  height=$(probe_value "$file" "v:0" height)
  v_codec=$(probe_value "$file" "v:0" codec_name)
  v_bitrate_raw=$(probe_value "$file" "v:0" bit_rate)
  fps_raw=$(probe_value "$file" "v:0" r_frame_rate)
  a_codec=$(probe_value "$file" "a:0" codec_name)
  a_sample_rate=$(probe_value "$file" "a:0" sample_rate)
  a_channels=$(probe_value "$file" "a:0" channels)
  file_size_mb=$(( $(stat -c%s "$file") / 1048576 ))

  # Resolve fps fraction (e.g. "30000/1001" → 29)
  local fps=0
  if [[ -n "$fps_raw" && "$fps_raw" == */* ]]; then
    local num den
    IFS='/' read -r num den <<< "$fps_raw"
    fps=$(echo "scale=2; $num / $den" | bc)
  elif [[ -n "$fps_raw" ]]; then
    fps="$fps_raw"
  fi

  local duration=0
  [[ -n "$duration_raw" ]] && duration=$(printf "%.0f" "$duration_raw")

  local v_bitrate_kbps=0
  if [[ -n "$v_bitrate_raw" && "$v_bitrate_raw" =~ ^[0-9]+$ ]]; then
    v_bitrate_kbps=$(( v_bitrate_raw / 1000 ))
  fi

  # ── Run checks ────────────────────────────────────────────────────────────

  # Container format
  local container_ok=false
  for c in $ALLOWED_CONTAINERS; do
    [[ "$container" == *"$c"* ]] && container_ok=true && break
  done
  if $container_ok; then
    checks+=("$(check pass "Container" "$container")")
  else
    checks+=("$(check fail "Container" "\"$container\" not in allowed list: $ALLOWED_CONTAINERS")")
    file_passed=false
  fi

  # Duration
  if (( duration >= MIN_DURATION_SEC && duration <= MAX_DURATION_SEC )); then
    checks+=("$(check pass "Duration" "${duration}s (range: ${MIN_DURATION_SEC}s–${MAX_DURATION_SEC}s)")")
  else
    checks+=("$(check fail "Duration" "${duration}s outside range ${MIN_DURATION_SEC}s–${MAX_DURATION_SEC}s")")
    file_passed=false
  fi

  # Resolution
  if [[ -n "$width" && -n "$height" ]] \
      && (( width >= MIN_WIDTH && height >= MIN_HEIGHT )) \
      && (( width <= MAX_WIDTH && height <= MAX_HEIGHT )); then
    checks+=("$(check pass "Resolution" "${width}x${height}")")
  else
    checks+=("$(check fail "Resolution" "${width:-?}x${height:-?} outside bounds ${MIN_WIDTH}x${MIN_HEIGHT}–${MAX_WIDTH}x${MAX_HEIGHT}")")
    file_passed=false
  fi

  # Video codec
  local vcodec_ok=false
  for c in $ALLOWED_VIDEO_CODECS; do
    [[ "$v_codec" == "$c" ]] && vcodec_ok=true && break
  done
  if $vcodec_ok; then
    checks+=("$(check pass "Video codec" "$v_codec")")
  else
    checks+=("$(check fail "Video codec" "\"${v_codec:-unknown}\" not in allowed list: $ALLOWED_VIDEO_CODECS")")
    file_passed=false
  fi

  # Video bitrate (skip if stream doesn't report it)
  if (( v_bitrate_kbps > 0 )); then
    if (( v_bitrate_kbps >= MIN_VIDEO_BITRATE_KBPS && v_bitrate_kbps <= MAX_VIDEO_BITRATE_KBPS )); then
      checks+=("$(check pass "Video bitrate" "${v_bitrate_kbps} kbps")")
    else
      checks+=("$(check fail "Video bitrate" "${v_bitrate_kbps} kbps outside range ${MIN_VIDEO_BITRATE_KBPS}–${MAX_VIDEO_BITRATE_KBPS} kbps")")
      file_passed=false
    fi
  else
    checks+=("$(check pass "Video bitrate" "N/A (not reported by stream)")")
  fi

  # Frame rate
  local fps_int
  fps_int=$(printf "%.0f" "$fps")
  if (( fps_int >= MIN_FPS && fps_int <= MAX_FPS )); then
    checks+=("$(check pass "Frame rate" "${fps} fps")")
  else
    checks+=("$(check fail "Frame rate" "${fps} fps outside range ${MIN_FPS}–${MAX_FPS} fps")")
    file_passed=false
  fi

  # Audio presence
  if [[ -z "$a_codec" ]]; then
    if $REQUIRE_AUDIO; then
      checks+=("$(check fail "Audio" "No audio stream found (required)")")
      file_passed=false
    else
      checks+=("$(check pass "Audio" "No audio (not required)")")
    fi
  else
    checks+=("$(check pass "Audio presence" "found")")

    # Audio codec
    local acodec_ok=false
    for c in $ALLOWED_AUDIO_CODECS; do
      [[ "$a_codec" == "$c" ]] && acodec_ok=true && break
    done
    if $acodec_ok; then
      checks+=("$(check pass "Audio codec" "$a_codec")")
    else
      checks+=("$(check fail "Audio codec" "\"$a_codec\" not in allowed list: $ALLOWED_AUDIO_CODECS")")
      file_passed=false
    fi

    # Sample rate
    if [[ -n "$a_sample_rate" ]] && (( a_sample_rate >= MIN_AUDIO_SAMPLE_RATE )); then
      checks+=("$(check pass "Audio sample rate" "${a_sample_rate} Hz")")
    else
      checks+=("$(check fail "Audio sample rate" "${a_sample_rate:-?} Hz below minimum ${MIN_AUDIO_SAMPLE_RATE} Hz")")
      file_passed=false
    fi

    # Channels
    if [[ -n "$a_channels" ]] && (( a_channels >= MIN_AUDIO_CHANNELS )); then
      checks+=("$(check pass "Audio channels" "$a_channels")")
    else
      checks+=("$(check fail "Audio channels" "${a_channels:-?} below minimum ${MIN_AUDIO_CHANNELS}")")
      file_passed=false
    fi
  fi

  # File size
  if (( MAX_FILE_SIZE_MB > 0 && file_size_mb > MAX_FILE_SIZE_MB )); then
    checks+=("$(check fail "File size" "${file_size_mb} MB exceeds maximum ${MAX_FILE_SIZE_MB} MB")")
    file_passed=false
  elif (( MAX_FILE_SIZE_MB > 0 )); then
    checks+=("$(check pass "File size" "${file_size_mb} MB")")
  fi

  # ── Emit result ───────────────────────────────────────────────────────────
  local verdict
  $file_passed && verdict="PASS" || verdict="FAIL"
  RESULTS+=("${file}|${verdict}|$(IFS=';'; echo "${checks[*]}")")

  (( TOTAL_FILES++ ))
  $file_passed && (( PASSED_FILES++ )) || (( FAILED_FILES++ ))
}

# ── Collect files ──────────────────────────────────────────────────────────────
collect_files() {
  local target="$1"
  local -a files=()

  if [[ -f "$target" ]]; then
    files=("$target")
  elif [[ -d "$target" ]]; then
    if $RECURSIVE; then
      while IFS= read -r -d '' f; do
        files+=("$f")
      done < <(find "$target" -type f \( \
        -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.mov" \
        -o -iname "*.avi" -o -iname "*.webm" -o -iname "*.flv" \
        -o -iname "*.wmv" -o -iname "*.m4v" \) -print0)
    else
      while IFS= read -r -d '' f; do
        files+=("$f")
      done < <(find "$target" -maxdepth 1 -type f \( \
        -iname "*.mp4" -o -iname "*.mkv" -o -iname "*.mov" \
        -o -iname "*.avi" -o -iname "*.webm" -o -iname "*.flv" \
        -o -iname "*.wmv" -o -iname "*.m4v" \) -print0)
    fi
  else
    die "Target not found: $target"
  fi

  echo "${files[@]}"
}

# ── Report renderers ───────────────────────────────────────────────────────────
render_text() {
  local out="${1:-/dev/stdout}"
  {
    echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}            UOC Video Evaluator — Report               ${RESET}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
    echo ""

    for result in "${RESULTS[@]}"; do
      IFS='|' read -r filepath verdict checks_str <<< "$result"
      echo -e "${BOLD}File:${RESET} $filepath"
      if [[ "$verdict" == "PASS" ]]; then
        echo -e "  ${BOLD}Overall:${RESET} ${GREEN}PASS${RESET}"
      else
        echo -e "  ${BOLD}Overall:${RESET} ${RED}FAIL${RESET}"
      fi

      if $VERBOSE || [[ "$verdict" == "FAIL" ]]; then
        IFS=';' read -ra checks <<< "$checks_str"
        for c in "${checks[@]}"; do
          IFS='|' read -r status name msg <<< "$c"
          if [[ "$status" == "PASS" ]]; then
            echo -e "    ${GREEN}✔${RESET} ${name}: ${msg}"
          else
            echo -e "    ${RED}✘${RESET} ${BOLD}${name}: ${msg}${RESET}"
          fi
        done
      fi
      echo ""
    done

    echo -e "${BOLD}───────────────────────────────────────────────────────${RESET}"
    echo -e "${BOLD}Summary:${RESET} ${TOTAL_FILES} file(s) evaluated"
    echo -e "  ${GREEN}Passed: ${PASSED_FILES}${RESET}"
    echo -e "  ${RED}Failed: ${FAILED_FILES}${RESET}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
  } | tee -a "$out" >/dev/null 2>&1 || {
    # fallback: just print to stdout
    for result in "${RESULTS[@]}"; do
      IFS='|' read -r filepath verdict checks_str <<< "$result"
      echo "File: $filepath  [$verdict]"
      IFS=';' read -ra checks <<< "$checks_str"
      for c in "${checks[@]}"; do
        IFS='|' read -r status name msg <<< "$c"
        echo "  [$status] $name: $msg"
      done
    done
  }

  # Always also print to stdout when a report file is set
  if [[ -n "$REPORT_FILE" ]]; then
    render_text_stdout
  fi
}

render_text_stdout() {
  echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}            UOC Video Evaluator — Report               ${RESET}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
  echo ""

  for result in "${RESULTS[@]}"; do
    IFS='|' read -r filepath verdict checks_str <<< "$result"
    echo -e "${BOLD}File:${RESET} $filepath"
    if [[ "$verdict" == "PASS" ]]; then
      echo -e "  ${BOLD}Overall:${RESET} ${GREEN}PASS${RESET}"
    else
      echo -e "  ${BOLD}Overall:${RESET} ${RED}FAIL${RESET}"
    fi

    if $VERBOSE || [[ "$verdict" == "FAIL" ]]; then
      IFS=';' read -ra checks <<< "$checks_str"
      for c in "${checks[@]}"; do
        IFS='|' read -r status name msg <<< "$c"
        if [[ "$status" == "PASS" ]]; then
          echo -e "    ${GREEN}✔${RESET} ${name}: ${msg}"
        else
          echo -e "    ${RED}✘${RESET} ${BOLD}${name}: ${msg}${RESET}"
        fi
      done
    fi
    echo ""
  done

  echo -e "${BOLD}───────────────────────────────────────────────────────${RESET}"
  echo -e "${BOLD}Summary:${RESET} ${TOTAL_FILES} file(s) evaluated"
  echo -e "  ${GREEN}Passed: ${PASSED_FILES}${RESET}"
  echo -e "  ${RED}Failed: ${FAILED_FILES}${RESET}"
  echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
}

render_json() {
  echo "["
  local first=true
  for result in "${RESULTS[@]}"; do
    $first || echo "  ,"
    first=false
    IFS='|' read -r filepath verdict checks_str <<< "$result"
    echo "  {"
    # Escape backslashes and quotes in filepath
    local escaped_path="${filepath//\\/\\\\}"
    escaped_path="${escaped_path//\"/\\\"}"
    echo "    \"file\": \"${escaped_path}\","
    echo "    \"verdict\": \"${verdict}\","
    echo "    \"checks\": ["
    local cfirst=true
    IFS=';' read -ra checks <<< "$checks_str"
    for c in "${checks[@]}"; do
      $cfirst || echo "      ,"
      cfirst=false
      IFS='|' read -r status name msg <<< "$c"
      local escaped_msg="${msg//\"/\\\"}"
      echo "      {\"status\": \"${status}\", \"criterion\": \"${name}\", \"detail\": \"${escaped_msg}\"}"
    done
    echo "    ]"
    echo "  }"
  done
  echo "]"
}

render_csv() {
  echo "file,verdict,criterion,status,detail"
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r filepath verdict checks_str <<< "$result"
    IFS=';' read -ra checks <<< "$checks_str"
    for c in "${checks[@]}"; do
      IFS='|' read -r status name msg <<< "$c"
      # Basic CSV escaping: wrap fields containing comma/quote in quotes
      local f="$filepath" v="$verdict" n="$name" m="$msg"
      for field_var in f v n m; do
        local val="${!field_var}"
        if [[ "$val" == *,* || "$val" == *'"'* ]]; then
          val="\"${val//\"/\"\"}\""
          printf -v "$field_var" '%s' "$val"
        fi
      done
      echo "${f},${v},${n},${status},${m}"
    done
  done
}

# ── Output dispatcher ─────────────────────────────────────────────────────────
emit_report() {
  local output
  case "$OUTPUT_FORMAT" in
    json)   output=$(render_json) ;;
    csv)    output=$(render_csv) ;;
    text|*) render_text_stdout; [[ -n "$REPORT_FILE" ]] && render_text_stdout > "$REPORT_FILE"; return ;;
  esac

  if [[ -n "$REPORT_FILE" ]]; then
    echo "$output" | tee "$REPORT_FILE"
  else
    echo "$output"
  fi
}

# ── Argument parsing ──────────────────────────────────────────────────────────
parse_args() {
  while getopts ":c:f:o:rvh" opt; do
    case $opt in
      c) CONFIG_FILE="$OPTARG" ;;
      f) OUTPUT_FORMAT="$OPTARG" ;;
      o) REPORT_FILE="$OPTARG" ;;
      r) RECURSIVE=true ;;
      v) VERBOSE=true ;;
      h) usage ;;
      :) die "Option -${OPTARG} requires an argument." ;;
      \?) die "Unknown option: -${OPTARG}" ;;
    esac
  done
  shift $(( OPTIND - 1 ))
  [[ $# -lt 1 ]] && { error "No target specified."; usage; }
  TARGET="$1"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  check_deps
  load_config

  local -a files
  read -ra files <<< "$(collect_files "$TARGET")"

  if [[ ${#files[@]} -eq 0 ]]; then
    warn "No video files found in: $TARGET"
    exit 0
  fi

  log "Evaluating ${#files[@]} file(s)…"
  for f in "${files[@]}"; do
    [[ -n "$f" ]] && evaluate_file "$f"
  done

  emit_report

  # Exit with non-zero if any file failed
  (( FAILED_FILES == 0 ))
}

main "$@"
