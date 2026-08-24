/**
 * A deliberately tiny growth layer: completed tasks are a gentle visual
 * trace, not a score or a progression system. The calculation is pure and
 * the DOM function only exposes stable classes for the host page to style.
 */

export const PLANT_STAGE_THRESHOLDS = Object.freeze([0, 1, 3, 6, 10]);

export const PLANT_STAGE_LABELS = Object.freeze([
  '一颗小种子',
  '冒出小芽',
  '长出叶子',
  '开出小花',
  '枝叶茂盛',
]);

function normalizeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}
export function countCompletedTasks(tasks = []) {
  return Array.isArray(tasks)
    ? tasks.filter(task => task?.status === 'completed').length
    : normalizeCount(tasks);
}

/** Return stage 0–4 for either a completed count or a task array. */
export function getPlantStage(tasksOrCount = 0) {
  const count = Array.isArray(tasksOrCount) ? countCompletedTasks(tasksOrCount) : normalizeCount(tasksOrCount);
  let stage = 0;
  for (let index = 0; index < PLANT_STAGE_THRESHOLDS.length; index += 1) {
    if (count >= PLANT_STAGE_THRESHOLDS[index]) stage = index;
  }
  return stage;
}

export function getPlantGrowth(tasksOrCount = 0) {
  const completedCount = Array.isArray(tasksOrCount) ? countCompletedTasks(tasksOrCount) : normalizeCount(tasksOrCount);
  const stage = getPlantStage(completedCount);
  return {
    completedCount,
    stage,
    label: PLANT_STAGE_LABELS[stage],
    className: `plant-stage-${stage}`,
  };
}

export function applyPlantGrowth(target, tasksOrCount = 0) {
  if (!target?.classList) return getPlantGrowth(tasksOrCount);
  const growth = getPlantGrowth(tasksOrCount);
  target.classList.remove(...PLANT_STAGE_THRESHOLDS.map((_, index) => `plant-stage-${index}`));
  target.classList.add(growth.className);
  if (target.dataset) {
    target.dataset.plantStage = String(growth.stage);
    target.dataset.completedCount = String(growth.completedCount);
  }
  return growth;
}

export function createPlantGrowthController(options = {}) {
  const target = options.target || null;
  let current = null;
  return Object.freeze({
    update(tasksOrCount = 0) {
      current = applyPlantGrowth(target, tasksOrCount);
      return current;
    },
    getCurrent: () => current,
  });
}
