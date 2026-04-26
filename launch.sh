#!/bin/bash
export DISPLAY=:0
cd /home/deck/dev/hydra
exec npx electron-vite dev --noSandbox
