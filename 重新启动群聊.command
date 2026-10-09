#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null; then
  /usr/bin/open "开始使用.html"
  exit 1
fi
agent_room_url="$(node control.mjs restart)"
if [[ $? -eq 0 ]]; then
  /usr/bin/open "$agent_room_url"
else
  print "请按上面的提示处理后重新打开。"
  read
fi
