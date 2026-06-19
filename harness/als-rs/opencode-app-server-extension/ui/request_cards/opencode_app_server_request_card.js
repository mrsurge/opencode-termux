function normalizeRequestMethod(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function escapeHtml(helpers, value) {
  if (typeof helpers?.escapeHtml === 'function') return helpers.escapeHtml(String(value ?? ''));
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function appendKeyValue(container, label, value, helpers) {
  if (value === null || value === undefined || value === '') return;
  const row = document.createElement('div');
  row.innerHTML = `<strong>${escapeHtml(helpers, label)}:</strong> ${escapeHtml(helpers, value)}`;
  container.append(row);
}

function appendMarkdown(container, label, value, helpers) {
  if (value === null || value === undefined || value === '') return;
  const row = document.createElement('div');
  const title = document.createElement('div');
  title.innerHTML = `<strong>${escapeHtml(helpers, label)}:</strong>`;
  const content = document.createElement('div');
  if (typeof helpers?.renderMarkdown === 'function') {
    helpers.renderMarkdown(content, String(value), 'approval-markdown');
  } else {
    content.textContent = String(value);
  }
  row.append(title, content);
  container.append(row);
}

function createFeedbackNode(body) {
  const feedback = document.createElement('div');
  feedback.className = 'approval-feedback';
  body.append(feedback);
  return feedback;
}

function setFeedback(node, message, isError = false) {
  if (!(node instanceof HTMLElement)) return;
  node.textContent = message || '';
  node.style.color = isError ? '#c62828' : '';
}

async function trySubmit(helpers, result, feedbackNode, pendingMessage = 'Sending response...') {
  setFeedback(feedbackNode, pendingMessage, false);
  const outcome = await helpers.submitResult(result, {});
  if (!outcome || outcome.ok === false) {
    const message = outcome?.response?.error || outcome?.error || 'Request failed';
    setFeedback(feedbackNode, message, true);
    return false;
  }
  return true;
}

function addJsonDetails(body, label, value) {
  if (value === null || value === undefined || value === '') return;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  const pre = document.createElement('pre');
  pre.className = 'approval-extra';
  pre.textContent = JSON.stringify(value, null, 2);
  details.append(summary, pre);
  body.append(details);
}

function languageFromPath(filePath) {
  const fileName = String(filePath || '').split('/').pop();
  const dotIndex = fileName.lastIndexOf('.');
  const ext = dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';
  const map = {
    bash: 'bash',
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    mjs: 'javascript',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'typescript',
    txt: 'plaintext',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return map[ext] || ext || 'plaintext';
}

function highlightCode(helpers, code, language) {
  const text = String(code || '');
  const lang = String(language || '').trim();
  if (typeof helpers?.highlightCodeAlways === 'function') {
    return helpers.highlightCodeAlways(text, lang);
  }
  const highlighter = globalThis.hljs;
  if (highlighter && lang && typeof highlighter.getLanguage === 'function' && highlighter.getLanguage(lang)) {
    try {
      return highlighter.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(helpers, text);
    }
  }
  return escapeHtml(helpers, text);
}

function addCodeDetails(body, label, value, filePath, helpers, { open = false } = {}) {
  if (typeof value !== 'string' || !value) return;
  const language = languageFromPath(filePath);
  const details = document.createElement('details');
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = label;
  const pre = document.createElement('pre');
  pre.className = 'approval-extra';
  const code = document.createElement('code');
  code.className = language ? `hljs language-${language}` : 'hljs';
  code.innerHTML = highlightCode(helpers, value, language);
  pre.append(code);
  details.append(summary, pre);
  body.append(details);
}

function renderDiffPreview(body, diffText, filePath, helpers) {
  if (!diffText) return;
  const diffBlock = document.createElement('div');
  diffBlock.className = 'diff-block';
  if (typeof helpers?.renderDiffBlock === 'function') {
    helpers.renderDiffBlock(diffBlock, diffText, filePath || '');
  } else if (typeof helpers?.formatDiff === 'function') {
    diffBlock.innerHTML = helpers.formatDiff(diffText, filePath || null);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'approval-extra';
    pre.textContent = diffText;
    diffBlock.append(pre);
  }
  body.append(diffBlock);
}

function renderReadOnly(body, event) {
  if (event?.replay !== true && typeof event?.status !== 'string') return false;
  const feedback = createFeedbackNode(body);
  const decision = typeof event?.decision === 'string' ? event.decision : '';
  const status = typeof event?.status === 'string' ? event.status : 'Recorded response';
  feedback.textContent = decision ? `${status}: ${decision}` : status;
  return true;
}

function renderActions(body, helpers, details) {
  const feedback = createFeedbackNode(body);
  const actions = document.createElement('div');
  actions.className = 'actions';

  const approve = document.createElement('button');
  approve.className = 'btn tiny approve';
  approve.textContent = 'Approve';
  approve.addEventListener('click', async () => {
    await trySubmit(helpers, { decision: 'accept' }, feedback);
  });
  actions.append(approve);

  const detailType = typeof details.type === 'string' ? details.type.trim().toLowerCase() : '';
  if (detailType === 'edit') {
    const applyAlways = document.createElement('button');
    applyAlways.className = 'btn tiny approve';
    applyAlways.textContent = 'Always';
    applyAlways.addEventListener('click', async () => {
      await trySubmit(helpers, { decision: 'proceed_always' }, feedback);
    });
    actions.append(applyAlways);
  }

  const decline = document.createElement('button');
  decline.className = 'btn tiny decline';
  decline.textContent = 'Decline';
  decline.addEventListener('click', async () => {
    await trySubmit(helpers, { decision: 'decline' }, feedback);
  });
  actions.append(decline);

  body.append(actions);
}

function normalizeQuestions(event) {
  const payload = objectValue(event.payload);
  const requestParams = objectValue(event.request_params || event.requestParams);
  const questions = Array.isArray(requestParams.questions) ? requestParams.questions : payload.questions;
  if (Array.isArray(questions) && questions.length) return questions;
  const question = String(requestParams.question || payload.question || '').trim();
  if (!question) return [];
  const choices = Array.isArray(requestParams.choices) ? requestParams.choices : payload.choices;
  return [{
    header: 'Question',
    question,
    options: Array.isArray(choices)
      ? choices.map((label) => ({ label: String(label || ''), description: '' })).filter((item) => item.label)
      : [],
    custom: requestParams.allowFreeform !== false && payload.allowFreeform !== false,
  }];
}

function optionLabel(option) {
  if (typeof option === 'string') return option;
  if (option && typeof option === 'object') return String(option.label || '').trim();
  return '';
}

function optionDescription(option) {
  if (option && typeof option === 'object') return String(option.description || '').trim();
  return '';
}

function addQuestionOptions(form, question, index, helpers) {
  const multiple = question?.multiple === true;
  const options = Array.isArray(question?.options) ? question.options : [];
  const group = document.createElement('div');
  group.className = 'approval-summary';
  options.forEach((option, optionIndex) => {
    const labelText = optionLabel(option);
    if (!labelText) return;
    const optionId = `opencode-question-${index}-${optionIndex}`;
    const row = document.createElement('label');
    row.className = 'approval-option';
    row.setAttribute('for', optionId);

    const input = document.createElement('input');
    input.type = multiple ? 'checkbox' : 'radio';
    input.name = `question-${index}`;
    input.id = optionId;
    input.value = labelText;
    row.append(input);

    const text = document.createElement('span');
    text.innerHTML = escapeHtml(helpers, labelText);
    row.append(text);

    const description = optionDescription(option);
    if (description) {
      const detail = document.createElement('div');
      detail.className = 'approval-option-description';
      detail.textContent = description;
      row.append(detail);
    }
    group.append(row);
  });

  if (question?.custom !== false) {
    const custom = document.createElement('textarea');
    custom.name = `question-${index}-custom`;
    custom.className = 'approval-extra';
    custom.rows = 2;
    custom.placeholder = 'Type your own answer';
    group.append(custom);
  }
  form.append(group);
}

function collectQuestionAnswers(form, count) {
  const answers = [];
  for (let index = 0; index < count; index += 1) {
    const selected = Array.from(form.querySelectorAll(`input[name="question-${index}"]:checked`))
      .map((input) => input instanceof HTMLInputElement ? input.value.trim() : '')
      .filter(Boolean);
    const custom = form.querySelector(`textarea[name="question-${index}-custom"]`);
    if (custom instanceof HTMLTextAreaElement && custom.value.trim()) {
      selected.push(custom.value.trim());
    }
    answers.push(selected);
  }
  return answers;
}

function readonlyAnswers(event, index) {
  const result = objectValue(event.result);
  const answers = Array.isArray(result.answers) ? result.answers : [];
  const answer = answers[index];
  if (!Array.isArray(answer)) return [];
  return answer.map((item) => String(item || '').trim()).filter(Boolean);
}

function renderUserInputCard(body, event, helpers) {
  const questions = normalizeQuestions(event);
  body.innerHTML = '';

  const form = document.createElement('form');
  questions.forEach((question, index) => {
    const questionObject = objectValue(question);
    const summary = document.createElement('div');
    summary.className = 'approval-summary';
    appendKeyValue(summary, 'Header', questionObject.header || `Question ${index + 1}`, helpers);
    appendMarkdown(summary, 'Question', questionObject.question || '', helpers);
    form.append(summary);
    addQuestionOptions(form, questionObject, index, helpers);

    const previous = readonlyAnswers(event, index);
    if (previous.length) {
      const answered = document.createElement('div');
      answered.className = 'approval-summary';
      appendKeyValue(answered, 'Response', previous.join(', '), helpers);
      form.append(answered);
    }
  });
  body.append(form);

  if (renderReadOnly(body, event)) return;

  const feedback = createFeedbackNode(body);
  const actions = document.createElement('div');
  actions.className = 'actions';

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn tiny approve';
  submit.textContent = 'Submit';
  submit.addEventListener('click', async () => {
    await trySubmit(helpers, { decision: 'accept', answers: collectQuestionAnswers(form, questions.length) }, feedback);
  });
  actions.append(submit);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn tiny decline';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', async () => {
    await trySubmit(helpers, { decision: 'decline' }, feedback);
  });
  actions.append(dismiss);

  body.append(actions);
}

function renderApprovalCard(body, event, helpers) {
  const payload = objectValue(event.payload);
  const requestParams = objectValue(event.request_params || event.requestParams);
  const details = objectValue(payload.details || requestParams.details);
  body.innerHTML = '';

  const summary = document.createElement('div');
  summary.className = 'approval-summary';
  appendKeyValue(summary, 'Kind', event.kind || details.type || 'tool', helpers);
  appendKeyValue(summary, 'Tool', payload.toolName || requestParams.toolName || '', helpers);
  appendKeyValue(summary, 'Title', payload.title || details.title || '', helpers);
  appendKeyValue(summary, 'Command', payload.command || details.command || '', helpers);
  appendKeyValue(summary, 'Path', payload.filePath || details.filePath || event.path || '', helpers);
  appendKeyValue(summary, 'Server', payload.serverName || details.serverName || requestParams.serverName || '', helpers);
  appendMarkdown(summary, 'Prompt', payload.prompt || details.prompt || details.systemMessage || '', helpers);
  body.append(summary);

  const diff = payload.fileDiff || details.fileDiff || event.diff || '';
  const filePath = payload.filePath || details.filePath || event.path || '';
  if (diff) {
    renderDiffPreview(body, diff, filePath, helpers);
  }
  addCodeDetails(body, 'Proposed content', payload.newContent || details.newContent || '', filePath, helpers);
  addJsonDetails(body, 'Arguments', payload.arguments || requestParams.arguments);

  if (!renderReadOnly(body, event)) {
    renderActions(body, helpers, details);
  }
}

export function initializeRequestCardModule() {}

export async function renderRequestCard(ctx = {}) {
  const event = ctx.event && typeof ctx.event === 'object' ? ctx.event : {};
  const helpers = ctx.helpers && typeof ctx.helpers === 'object' ? ctx.helpers : {};
  const body = ctx.body;
  if (!(body instanceof HTMLElement)) return false;
  const requestMethod = normalizeRequestMethod(event.request_method || event.requestMethod);
  if (requestMethod === 'turn/userinputrequested') {
    renderUserInputCard(body, event, helpers);
    return true;
  }
  if (requestMethod !== 'turn/toolapprovalrequested') return false;
  renderApprovalCard(body, event, helpers);
  return true;
}
