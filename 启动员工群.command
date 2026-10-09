#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  print "需要安装 Node.js 22 或更高版本，已打开开始使用说明。"
  /usr/bin/open "开始使用.html"
  read
  exit 1
fi
agent_room_url="$(node launch.mjs)"
if [[ $? -eq 0 ]]; then
  /usr/bin/open "$agent_room_url"
else
  print "请按上面的提示处理，然后重新启动。"
  read
fi
