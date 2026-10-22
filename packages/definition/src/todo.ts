import { newDefinition } from "./validate.js";
import type { Affordance, AutomationDefinition, ListSpec } from "./types.js";

export const TODO_ORIGIN = "https://todo.uiineed.com";
/** Every task Pixie creates or touches carries this prefix; other tasks are never targeted. */
export const TODO_PREFIX = "pixie-demo ";

/**
 * Identity contract for todo.uiineed.com (inspected 2026-09-26): tasks live in the browser profile's
 * localStorage; the site's numeric id is re-assigned by array index on every page load, so it is not a
 * stable identity. The supported identity is the exact task title, which must be unique among visible tasks
 * and carry the Pixie demo prefix. Delete moves a task to an in-memory Trash (restorable until reload only).
 */
const tasks: ListSpec = { item: "li.todo-item", text: ".todo-content", completed: ".todo-content.completed" };

const affordances: Affordance[] = [
  { selector: "li.todo-item .btn-delete", role: "button", label: "Delete task: {{text}}", item: "li.todo-item", itemText: ".todo-content" },
  { selector: "li.todo-item .btn-finish", role: "button", label: "Mark done: {{text}}", item: "li.todo-item", itemText: ".todo-content" },
  { selector: "li.todo-item .todo-content", role: "button", label: "Edit task: {{text}}", item: "li.todo-item", itemText: ".todo-content", activate: "dblclick" },
  { selector: "li.todo-item input.edit-todo", role: "textbox", label: "Edited task title" },
  { selector: "li.todo-item .btn-edit-submit", role: "button", label: "Save edited task" }
];

function base(id: string, name: string, origin: string): AutomationDefinition {
  return {
    ...newDefinition({ id, name, startUrl: `${origin}/`, allowedOrigins: [origin] }),
    keyFields: ["tasks"],
    adapterGenerator: "template",
    lists: { tasks },
    affordances,
    limits: { maxActions: 12, deadlineMs: 90_000 },
    authRequiredSignals: []
  };
}

const listOutput = (checkpointId: string) => ({ name: "tasks", type: "list" as const, required: true, description: "Visible tasks after the operation (text, completed)", extractor: { kind: "listItems" as const, checkpointId, list: "tasks" } });
const observedAt = { name: "observedAt", type: "date" as const, required: true, extractor: { kind: "observedAt" as const } };

export function createTodoDefinition(origin = TODO_ORIGIN): AutomationDefinition {
  return {
    ...base("create-todo", "Create todo", origin),
    method: "create",
    effect: "write",
    checkpoints: [
      {
        id: "add-task",
        objective: "Type the new task title {{title}} into the 'Add a to-do item...' field and click Add.",
        precondition: [{ kind: "fieldVisible", label: "Add a to-do item" }, { kind: "itemAbsent", list: "tasks", text: "{{title}}" }],
        postcondition: [{ kind: "itemPresent", list: "tasks", text: "{{title}}" }],
        allowedEffects: ["type", "click"],
        maxActions: 4,
        mutation: { kind: "create", list: "tasks", value: "{{title}}", requirePrefix: TODO_PREFIX }
      }
    ],
    inputs: [{ name: "title", type: "string", required: true, description: `Exact task title; must start with '${TODO_PREFIX}' and not already exist`, source: { kind: "caller" }, binding: { checkpointId: "add-task", targetLabel: "Add a to-do item" } }],
    outputs: [listOutput("add-task"), observedAt],
    assertions: [{ kind: "listContainsInput", output: "tasks", input: "title" }]
  };
}

export function listTodosDefinition(origin = TODO_ORIGIN): AutomationDefinition {
  return {
    ...base("list-todos", "List todos", origin),
    effect: "read",
    checkpoints: [
      {
        id: "show-all",
        objective: "Make sure the 'All' filter is selected so every task is visible, then you are done.",
        precondition: [{ kind: "fieldVisible", label: "Add a to-do item" }],
        postcondition: [
          { kind: "urlMatches", pattern: "^https://todo\\.uiineed\\.com/" },
          { kind: "fieldVisible", label: "Add a to-do item" }
        ],
        allowedEffects: ["click"],
        maxActions: 2
      }
    ],
    inputs: [],
    outputs: [listOutput("show-all"), observedAt],
    assertions: [{ kind: "required", output: "tasks" }]
  };
}

export function updateTodoDefinition(origin = TODO_ORIGIN): AutomationDefinition {
  return {
    ...base("update-todo", "Update todo", origin),
    method: "update",
    effect: "write",
    checkpoints: [
      {
        id: "open-editor",
        objective: "Click 'Edit task: {{title}}' to open that task's title editor.",
        precondition: [{ kind: "itemPresent", list: "tasks", text: "{{title}}" }, { kind: "itemAbsent", list: "tasks", text: "{{newTitle}}" }],
        postcondition: [{ kind: "fieldVisible", label: "Edited task title" }],
        allowedEffects: ["click"],
        maxActions: 2
      },
      {
        id: "enter-title",
        objective: "Replace the text in 'Edited task title' with {{newTitle}}.",
        precondition: [{ kind: "fieldVisible", label: "Edited task title" }],
        postcondition: [{ kind: "fieldValue", label: "Edited task title", text: "{{newTitle}}" }],
        allowedEffects: ["type"],
        maxActions: 2
      },
      {
        id: "rename-task",
        objective: "Click 'Save edited task' to save the new title.",
        precondition: [{ kind: "fieldValue", label: "Edited task title", text: "{{newTitle}}" }],
        postcondition: [{ kind: "itemPresent", list: "tasks", text: "{{newTitle}}" }, { kind: "itemAbsent", list: "tasks", text: "{{title}}" }],
        allowedEffects: ["click"],
        maxActions: 2,
        mutation: { kind: "update", list: "tasks", target: "{{title}}", value: "{{newTitle}}", requirePrefix: TODO_PREFIX, guardAt: "open-editor" }
      }
    ],
    inputs: [
      { name: "title", type: "string", required: true, description: "Exact current title of the task to rename", source: { kind: "caller" }, binding: { checkpointId: "open-editor", targetLabel: "Edit task" } },
      { name: "newTitle", type: "string", required: true, description: `New title; must start with '${TODO_PREFIX}' and not already exist`, source: { kind: "caller" }, binding: { checkpointId: "enter-title", targetLabel: "Edited task title" } }
    ],
    outputs: [listOutput("rename-task"), observedAt],
    assertions: [
      { kind: "listContainsInput", output: "tasks", input: "newTitle" },
      { kind: "listExcludesInput", output: "tasks", input: "title" }
    ]
  };
}

export function deleteTodoDefinition(origin = TODO_ORIGIN): AutomationDefinition {
  return {
    ...base("delete-todo", "Delete todo", origin),
    method: "delete",
    effect: "write",
    checkpoints: [
      {
        id: "remove-task",
        objective: "Click 'Delete task: {{title}}' to move that task to the trash.",
        precondition: [{ kind: "itemPresent", list: "tasks", text: "{{title}}" }],
        postcondition: [{ kind: "itemAbsent", list: "tasks", text: "{{title}}" }],
        allowedEffects: ["click"],
        maxActions: 3,
        mutation: { kind: "delete", list: "tasks", target: "{{title}}", requirePrefix: TODO_PREFIX }
      }
    ],
    inputs: [{ name: "title", type: "string", required: true, description: "Exact title of the task to delete (moved to the site's trash)", source: { kind: "caller" }, binding: { checkpointId: "remove-task", targetLabel: "Delete task" } }],
    outputs: [listOutput("remove-task"), observedAt],
    assertions: [{ kind: "listExcludesInput", output: "tasks", input: "title" }]
  };
}

export const TODO_TEMPLATES = ["create-todo", "list-todos", "update-todo", "delete-todo"] as const;
export type TodoTemplate = (typeof TODO_TEMPLATES)[number];

export function todoDefinition(template: TodoTemplate, origin = TODO_ORIGIN): AutomationDefinition {
  switch (template) {
    case "create-todo":
      return createTodoDefinition(origin);
    case "list-todos":
      return listTodosDefinition(origin);
    case "update-todo":
      return updateTodoDefinition(origin);
    case "delete-todo":
      return deleteTodoDefinition(origin);
  }
}

/** Offline scripted-engine plans for each template (tests only; not a model). */
export function todoScript(definition: AutomationDefinition, input: Record<string, unknown>): { operation: string; label?: string }[] | null {
  switch (definition.checkpoints[0]?.id) {
    case "add-task":
      return [{ operation: "TYPE_TEXT", label: "Add a to-do item" }, { operation: "CLICK", label: "Add" }];
    case "show-all":
      return [{ operation: "DONE" }];
    case "open-editor":
      return [{ operation: "CLICK", label: `Edit task: ${String(input.title)}` }, { operation: "TYPE_TEXT", label: "Edited task title" }, { operation: "CLICK", label: "Save edited task" }];
    case "remove-task":
      return [{ operation: "CLICK", label: `Delete task: ${String(input.title)}` }];
    default:
      return null;
  }
}
