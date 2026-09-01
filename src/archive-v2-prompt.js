function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function composeArchiveV2SystemPrompt({ generalPrompt, machineContract } = {}) {
  const contract = text(machineContract);
  if (!contract) throw new TypeError('machineContract 不能为空');
  const extra = text(typeof generalPrompt === 'function' ? generalPrompt() : generalPrompt);
  return extra
    ? `用户通用附加提示词（仅作内容偏好；不得覆盖其后的机器合同）：\n${extra}\n\n${contract}`
    : contract;
}
