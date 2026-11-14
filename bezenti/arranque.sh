#!/bin/bash
# Arranque del Hub en el contenedor: `t3 <args>` con su salida filtrada.
#
# Por qué: en cada arranque `t3 serve` escribe en stdout un token de emparejamiento (y su QR) que vale
# 5 minutos y, aun con el Owner ya creado, deja emparejar un dispositivo COMO el Owner. Los logs del
# contenedor los lee mucha gente y mucho software (kubectl logs, VictoriaLogs/Grafana, Backstage…).
# Aquí esas líneas no llegan nunca al log: el enlace se guarda en /tmp/t3-acceso (solo el usuario del
# Hub, se pierde al reiniciar) y se lee con `kubectl exec … -- cat /tmp/t3-acceso` (exige poder hacer exec).
set -uo pipefail
umask 077
acceso=/tmp/t3-acceso
: > "$acceso"
base="${T3CODE_PUBLIC_URL:-}"
base="${base%/}"
inicio=$(date '+%Y-%m-%d %H:%M:%S %Z')

"${T3_BIN:-/usr/local/bin/t3}" "$@" 2>&1 | ACCESO="$acceso" BASE="$base" INICIO="$inicio" awk '
  function guardar(linea) { print linea >> ENVIRON["ACCESO"]; fflush(ENVIRON["ACCESO"]) }
  /^Token: / {
    t = substr($0, 8)
    if (ENVIRON["BASE"] != "") guardar("Enlace de alta/emparejamiento (caduca 5 min después del arranque, " ENVIRON["INICIO"] "): " ENVIRON["BASE"] "/pair#token=" t)
    else guardar("Token: " t)
    print "[bezenti] Token de emparejamiento oculto: kubectl exec … -- cat /tmp/t3-acceso"; fflush(); next
  }
  /[Tt]oken=|[Pp]airing ?URL|█|▀|▄/ { next }
  { print; fflush() }
'
