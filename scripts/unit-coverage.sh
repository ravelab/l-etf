#!/bin/sh
# Back-compat alias — coverage is reported at the end of the unit suite itself.
set -eu
exec "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/unit-test.sh"
