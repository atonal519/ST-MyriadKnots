// 成功的无变化模型夹具也交回本楼已复核的完整情境；编译负例直接传原响应。
export function reviewedCsePacket(input) {
  const request = input.request ?? (input.taskMessages ? JSON.parse(input.taskMessages[0].content) : input);
  const payload = request.payload;
  return { subjects: payload.trackedSubjects.filter(subject => !subject.reviewOnly).map(subject => {
    const situational = payload.previousState.find(previous => previous.subject === subject.name)?.ownState.situational ?? [];
    return { subject: subject.name, situational: {
      self: situational.filter(item => !item.toward), relations: situational.filter(item => item.toward),
    } };
  }) };
}
