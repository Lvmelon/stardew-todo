import { createTask, updateTask, completeTask, deleteTask, visibleTasks, validateTaskInput } from './task-model.js';
import { createTaskStore } from './storage.js';

const store = createTaskStore();
const DEFAULT_TASKS = [
  { id:'seed-1', title:'记得取快递', description:'路过驿站的时候别忘啦。', emoji:'📦', dueDate:'', status:'open', createdAt:'2026-08-25T00:00:01.000Z', updatedAt:'2026-08-25T00:00:01.000Z' },
  { id:'seed-2', title:'清洗常用的杯子', description:'把每天用的杯子洗干净。', emoji:'🥤', dueDate:'', status:'open', createdAt:'2026-08-25T00:00:00.500Z', updatedAt:'2026-08-25T00:00:00.500Z' },
  { id:'seed-3', title:'提醒你该喝水了', description:'忙起来也要记得喝水。', emoji:'💧', dueDate:'', status:'open', createdAt:'2026-08-25T00:00:00.000Z', updatedAt:'2026-08-25T00:00:00.000Z' },
];

let tasks = [];
let selectedId = null;
let editingId = null;

const $ = id => document.getElementById(id);
const taskList = $('task-list');
const emptyState = $('empty-state');
const overflowCount = $('overflow-count');
const detailModal = $('detail-modal');
const editorModal = $('editor-modal');
const deleteModal = $('delete-modal');
const allModal = $('all-modal');
const detailTitle = $('detail-title');
const detailDesc = $('detail-desc');
const detailDate = $('detail-date');
const editorHeading = $('editor-heading');
const titleInput = $('task-title-input');
const descInput = $('task-desc-input');
const emojiInput = $('task-emoji-input');
const dateInput = $('task-date-input');
const formError = $('form-error');
const toast = $('toast');
const allTaskList = $('all-task-list');

function setModal(modal, open) {
  modal.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function getOpenTasks() {
  return tasks.filter(task => task.status === 'open').sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function renderTasks() {
  const open = getOpenTasks();
  const shown = visibleTasks(tasks, 5);
  taskList.replaceChildren();
  emptyState.hidden = shown.length > 0;
  if (!shown.length) emptyState.style.display = 'flex'; else emptyState.style.display = 'none';

  for (const task of shown) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'task-row';
    row.dataset.taskRow = '';
    row.dataset.id = task.id;
    row.setAttribute('aria-label', `查看任务：${task.title}`);

    const mark = document.createElement('span');
    mark.className = 'task-mark';
    mark.setAttribute('aria-hidden','true');
    const emoji = document.createElement('span');
    emoji.className = 'task-emoji';
    emoji.textContent = task.emoji || '📌';
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    row.append(mark, emoji, title);
    row.addEventListener('click', () => openDetail(task.id));
    taskList.appendChild(row);
  }

  const extra = Math.max(0, open.length - 5);
  overflowCount.hidden = extra === 0;
  overflowCount.textContent = extra ? `还有 ${extra} 项 ›` : '';
  renderAllTasks();
}

function renderAllTasks() {
  allTaskList.replaceChildren();
  const open = getOpenTasks();
  for (const task of open) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'all-task-item';
    btn.textContent = `${task.emoji || '📌'} ${task.title}`;
    if (task.dueDate) {
      const small = document.createElement('small');
      small.textContent = `截止：${formatDateOnly(task.dueDate)}`;
      btn.appendChild(small);
    }
    btn.addEventListener('click', () => { setModal(allModal,false); openDetail(task.id); });
    allTaskList.appendChild(btn);
  }
}

function openDetail(id) {
  const task = tasks.find(item => item.id === id && item.status === 'open');
  if (!task) return;
  selectedId = id;
  detailTitle.textContent = `${task.emoji || '📌'} ${task.title}`;
  detailDesc.textContent = task.description || '这条任务没有额外备注。';
  detailDate.hidden = !task.dueDate;
  detailDate.textContent = task.dueDate ? `截止日期：${formatDateOnly(task.dueDate)}` : '';
  setModal(detailModal, true);
}

function openEditor(id = null) {
  editingId = id;
  const task = id ? tasks.find(item => item.id === id) : null;
  editorHeading.textContent = task ? '编辑任务' : '新任务';
  $('save-task').textContent = task ? '保存修改' : '贴到公告板';
  titleInput.value = task?.title || '';
  descInput.value = task?.description || '';
  emojiInput.value = task?.emoji || '📌';
  dateInput.value = task?.dueDate || '';
  formError.textContent = '';
  setModal(detailModal, false);
  setModal(editorModal, true);
  window.setTimeout(() => titleInput.focus(), 40);
}

async function saveTaskFromForm(event) {
  event.preventDefault();
  const input = { title:titleInput.value, description:descInput.value, emoji:emojiInput.value, dueDate:dateInput.value };
  const validation = validateTaskInput(input);
  if (!validation.ok) { formError.textContent = validation.message; titleInput.focus(); return; }
  try {
    if (editingId) {
      const index = tasks.findIndex(item => item.id === editingId);
      if (index >= 0) {
        tasks[index] = updateTask(tasks[index], input);
        await store.put(tasks[index]);
        showToast('任务已经更新');
      }
    } else {
      const task = createTask(input);
      tasks.push(task);
      await store.put(task);
      showToast('新任务已经贴好');
    }
    editingId = null;
    setModal(editorModal, false);
    renderTasks();
  } catch (error) {
    formError.textContent = error?.message || '保存失败，请稍后再试';
  }
}

async function completeSelected() {
  const id = selectedId;
  if (!id) return;
  const task = tasks.find(item => item.id === id);
  if (!task) return;
  setModal(detailModal, false);
  const row = taskList.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.add('completing');
    spawnSparkles(row.getBoundingClientRect());
  }
  await new Promise(resolve => setTimeout(resolve, 520));
  const updated = completeTask(task);
  tasks[tasks.findIndex(item => item.id === id)] = updated;
  await store.put(updated);
  selectedId = null;
  renderTasks();
  showToast('任务完成 ✦');
}

function askDelete() {
  if (!selectedId) return;
  setModal(detailModal, false);
  setModal(deleteModal, true);
}

async function confirmDelete() {
  if (!selectedId) return;
  const index = tasks.findIndex(item => item.id === selectedId);
  if (index < 0) return;
  const updated = deleteTask(tasks[index]);
  tasks[index] = updated;
  await store.put(updated);
  selectedId = null;
  setModal(deleteModal, false);
  renderTasks();
  showToast('已从公告板移除');
}

function spawnSparkles(rect) {
  for (let i=0; i<10; i++) {
    const spark = document.createElement('i');
    spark.className = 'spark';
    spark.style.left = `${rect.left + rect.width * (.18 + Math.random() * .64)}px`;
    spark.style.top = `${rect.top + rect.height * (.2 + Math.random() * .6)}px`;
    spark.style.setProperty('--dx', `${(Math.random() - .5) * 90}px`);
    spark.style.setProperty('--dy', `${-20 - Math.random() * 70}px`);
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 680);
  }
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1300);
}

function updateCalendar() {
  const now = new Date();
  $('current-date').textContent = `${now.getMonth()+1}月${now.getDate()}日`;
  $('current-weekday').textContent = `周${'日一二三四五六'[now.getDay()]}`;
  const hour = now.getHours();
  $('greeting-text').textContent = hour < 6 ? '夜深了，别忘了早点休息哦！' : hour < 11 ? '早安，开始今天的任务吧！' : hour < 14 ? '中午好，看看还有什么任务吧！' : hour < 18 ? '下午好，慢慢完成今天的小事吧！' : '晚上好，看看今天还剩什么吧！';
}

function formatDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

async function initialize() {
  tasks = await store.getAll();
  if (!tasks.length) {
    tasks = DEFAULT_TASKS.map(task => ({...task}));
    await store.putMany(tasks);
  }
  updateCalendar();
  renderTasks();
  registerServiceWorker();
}

$('new-task-button').addEventListener('click', () => openEditor());
$('task-form').addEventListener('submit', saveTaskFromForm);
$('complete-task').addEventListener('click', completeSelected);
$('edit-task').addEventListener('click', () => selectedId && openEditor(selectedId));
$('delete-task').addEventListener('click', askDelete);
$('confirm-delete').addEventListener('click', confirmDelete);
overflowCount.addEventListener('click', () => setModal(allModal,true));

document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => {
    setModal($(button.dataset.close), false);
    if (button.dataset.close === 'editor-modal') editingId = null;
  });
});

document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', event => {
  if (event.target === modal) setModal(modal, false);
}));

initialize().catch(error => {
  console.error(error);
  showToast('任务数据加载失败');
});
