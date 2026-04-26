#!/bin/bash
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/run/user/1000
exec /home/deck/dev/hydra/dist/hydralauncher-3.9.5.AppImage --no-sandbox
