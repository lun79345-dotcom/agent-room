export function describeFailure(error) {
  const text = String(error?.message || error || '未知错误');
  const result = (code, message, action, retryable = false) => ({ code, message, action, retryable });
  if (/已停止/.test(text)) return result('stopped', '这一轮已停止。', '需要继续时，先确认原会话中的进度。', true);
  if (/turn\/start.*超时|turn\/start.*timed out/i.test(text)) return result('uncertain-delivery', '尚未确认原会话是否接收了这条消息。', '先打开原会话检查或同步进度，避免重复交办。');
  if (/401|unauthorized|not logged|authentication|oauth|登录|token.*expired/i.test(text)) return result('auth', '账号登录不可用。', '在对应 CLI 中重新登录，再点击“使用前检查”重新检查。', true);
  if (/429|rate.limit|usage.limit|quota|额度|credit.*exhaust|insufficient.credit/i.test(text)) return result('quota', '账号额度或调用频率受限。', '在原应用查看额度，额度恢复后再继续。', true);
  if (/ENOENT|找不到|尚未安装/i.test(text)) return result('missing', '没有找到所需程序或工作目录。', '打开“使用前检查”，检查程序位置和员工工作目录。');
  if (/method not found|unknown variant|experimental|unsupported|兼容版本/i.test(text)) return result('version', '当前应用版本缺少所需接口。', '打开“使用前检查”查看兼容情况，更新对应程序后重新检查。');
  if (/already has an active writer/i.test(text)) return result('writer', '原应用仍在保持这个会话。', '先确认 Codex 版本支持消息队列；完成原应用这一轮后再联系。', true);
  if (/timeout|超时|15 分钟/i.test(text)) return result('timeout', '等待回复超时。', '先到原会话核对是否仍在工作，再决定是否继续。');
  if (/network|fetch failed|ECONN|ENOTFOUND|socket|stream disconnected|连接已关闭|连接中断/i.test(text)) return result('connection', '与应用或模型服务的连接中断。', '检查网络和原应用状态，重新检查连接后可以再试。', true);
  if (/sandbox|permission|EACCES|EPERM|权限|拒绝/i.test(text)) return result('permission', '当前权限不足以完成这项操作。', '检查项目目录权限；原应用的确认请求请在原应用处理。');
  return result('other', '这一轮没有完成。', '先查看原会话中的具体原因；讨论消息可以手动再试。', true);
}
