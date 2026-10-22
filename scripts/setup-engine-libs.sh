#!/usr/bin/env bash
# setup-engine-libs.sh — reproducible system-library bootstrap for sandboxed engines.
#
# gmsh (PyPI wheel) links libGLU.so.1 + libOpenGL.so.0, which this sandbox image
# lacks. There is no root, so the .debs are downloaded and extracted into a
# user-local dir that the gmsh adapter bridge prepends to LD_LIBRARY_PATH
# (see docs/00-architecture/phase5-disciplines-contract.md §5.1).
#
# Idempotent: skips work when the libraries are already present. Offline-safe
# failure: prints the honest remediation and exits non-zero (never silently
# pretends the engine is usable).
set -euo pipefail

DEST="${EOS_ENGINE_LIBDIR:-$HOME/.local/lib/eos-engine-libs}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

need_lib() { # need_lib <soname-suffix> (e.g. "GLU.so.1") — true when the loader would NOT find it
  ! ldconfig -p 2>/dev/null | grep -q "lib$1"
}

mkdir -p "$DEST"

# libglu1-mesa provides libGLU.so.1; libopengl0 provides libOpenGL.so.0
fetch() { # fetch <package> <expected-soname-suffix>
  local pkg="$1" soname="$2"
  if [ -e "$DEST/lib${soname}" ] || ! need_lib "$soname"; then
    echo "ok: lib${soname} already available (local or system)"
    return
  fi
  echo "fetch: $pkg -> $DEST"
  ( cd "$WORK" && apt-get download "$pkg" >/dev/null 2>&1 || {
      echo "error: apt-get download $pkg failed (offline?)" >&2; exit 1; } )
  ( cd "$WORK" && dpkg -x ./*.deb extracted && cp -a extracted/usr/lib/*/lib*.so* "$DEST"/ )
  rm -f "$WORK"/*.deb && rm -rf "$WORK/extracted"
}

fetch libglu1-mesa GLU.so.1
fetch libopengl0 OpenGL.so.0

# verify both sonames resolve from $DEST
missing=0
for soname in GLU.so.1 OpenGL.so.0; do
  if ! LD_LIBRARY_PATH="$DEST" python3 -c "import ctypes; ctypes.CDLL('lib${soname}'); print('verified: lib${soname} loadable')" 2>/dev/null; then
    echo "error: lib${soname} still not loadable from $DEST" >&2
    missing=1
  fi
done

[ "$missing" -eq 0 ] && echo "engine libs ready: $DEST" || exit 1
