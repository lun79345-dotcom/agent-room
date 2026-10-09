#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if command -v node >/dev/null; then
  node control.mjs stop
else
  /usr/bin/open "开始使用.html"
fi
read
