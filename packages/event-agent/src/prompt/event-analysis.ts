type ConnectorEvent = {
  id: string;
  source: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

type EventTask = {
  id: string;
  title: string;
  prompt: string;
};

export function buildEventAnalysisPrompt(input: {
  task: EventTask;
  event: ConnectorEvent;
}): string {
  const { task, event } = input;
  const payloadJson = JSON.stringify(event.payload ?? {}, null, 2);

  return `[事件触发] 你的一个 standing 任务收到匹配事件。

任务：
- id: ${task.id}
- title: ${task.title}

任务定义：
${task.prompt}

事件：
- source: ${event.source}
- type: ${event.type}
- id: ${event.id}
- at: ${event.createdAt}
- payload:
${payloadJson}

按"任务定义"判断这条事件是否值得告诉用户。
- 值得：调用 notify，用 1–2 句简短的话主动告知，并引用关键字段（涨跌幅、标题、关键词、阈值）作为依据；如果用户需要做决定，直接说清楚需要他拍板的选项或下一步。
- 不值得（只是噪音、与任务定义不相关、没有行动窗口）：直接回复"忽略"两个字结束。

注意：
- 本轮由独立 event agent 执行，不属于主对话，不要复述事件分析过程。
- 用户可见动作只有 notify。不需要提醒时只回复"忽略"。
- 不要创建新任务。如果你判断需要扩大监听面，告诉用户而不是自己动手。`;
}
