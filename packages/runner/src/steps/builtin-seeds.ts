// 本文件所有改动要求遵循 agent-rules 规范
import type { ScriptKind, ScriptParamSpec } from '@gait/shared';

/**
 * 内置 step 的脚本库种子。
 *
 * 用途：脚本库（tenant 级）首次初始化或缺失内置条目时写入，
 * 使「脚本库是 step 的唯一定义来源」成立——runner 不再从代码里读取 BUILTIN_STEPS。
 * 说明文案面向 LLM，写得越具体，生成阶段越容易正确复用。
 */
export interface BuiltinStepSeed {
  moduleKey: string;
  name: string;
  kind: ScriptKind;
  pattern: string;
  description: string;
  params?: ScriptParamSpec[];
  examples?: string[];
}

const MODULE_UI_NAV = 'ui.nav';
const MODULE_UI_FORM = 'ui.form';
const MODULE_UI_ASSERT = 'ui.assert';
const MODULE_UI_AUTH = 'ui.auth';
const MODULE_API = 'api.request';
const MODULE_API_ASSERT = 'api.assert';
const MODULE_DB = 'db.query';
const MODULE_COMMON = 'common';

export const BUILTIN_STEP_SEEDS: readonly BuiltinStepSeed[] = [
  {
    moduleKey: MODULE_COMMON,
    name: 'environment-ready',
    kind: 'builtin',
    pattern: 'the test environment is ready',
    description: '前置检查：确认测试环境可用（API base URL 可达）。无参数，通常写在 Background。',
    examples: ['Given the test environment is ready'],
  },
  {
    moduleKey: MODULE_COMMON,
    name: 'wait',
    kind: 'builtin',
    pattern: 'I wait {int} milliseconds',
    description: '等待指定毫秒数（0-300000），用于异步收敛；优先用断言重试而不是固定等待。',
    params: [{ name: 'int', type: 'int', description: '等待毫秒数' }],
    examples: ['When I wait 500 milliseconds'],
  },
  {
    moduleKey: MODULE_UI_NAV,
    name: 'open-page',
    kind: 'builtin',
    pattern: 'I am on the {string} page',
    description: '打开相对 webBaseUrl 的页面路径。参数是站内路径，如 "/" 或 "/login"，不要写完整域名。',
    params: [{ name: 'string', type: 'string', description: '站内路径' }],
    examples: ['Given I am on the "/" page'],
  },
  {
    moduleKey: MODULE_UI_AUTH,
    name: 'enter-credentials',
    kind: 'builtin',
    pattern: 'I enter my username and password',
    description: '用环境配置的测试账号填写用户名与密码（不带参数，凭据来自 secret/env）。',
    examples: ['When I enter my username and password'],
  },
  {
    moduleKey: MODULE_UI_AUTH,
    name: 'enter-explicit-credentials',
    kind: 'builtin',
    pattern: 'I enter username {string} and password {string}',
    description: '填写指定用户名与密码。禁止写真实密码，应使用 {{secret.*}} 占位符。',
    params: [
      { name: 'string', type: 'string', description: '用户名' },
      { name: 'string', type: 'string', description: '密码或 {{secret.*}} 占位符' },
    ],
    examples: ['When I enter username "{{env.DEMO_USERNAME}}" and password "{{secret.demo.password}}"'],
  },
  {
    moduleKey: MODULE_UI_AUTH,
    name: 'logged-in-as',
    kind: 'template',
    pattern: 'I am logged in as {string}',
    description: '以指定账号完成登录（模板 step，内部走登录流程）。',
    params: [{ name: 'string', type: 'string', description: '账号名/角色名' }],
    examples: ['Given I am logged in as "admin"'],
  },
  {
    moduleKey: MODULE_UI_NAV,
    name: 'redirected-to',
    kind: 'builtin',
    pattern: 'I should be redirected to the {string} page',
    description: '断言当前 URL 已跳转到指定站内路径。',
    params: [{ name: 'string', type: 'string', description: '目标路径' }],
    examples: ['Then I should be redirected to the "/" page'],
  },
  {
    moduleKey: MODULE_UI_NAV,
    name: 'stay-on-page',
    kind: 'builtin',
    pattern: 'I should stay on the {string} page',
    description: '断言当前仍停留在指定页面，用于验证失败场景未跳转。',
    params: [{ name: 'string', type: 'string', description: '当前路径' }],
    examples: ['Then I should stay on the "/login" page'],
  },
  {
    moduleKey: MODULE_UI_ASSERT,
    name: 'see-error',
    kind: 'builtin',
    pattern: 'I should see the error {string}',
    description: '断言页面上出现了指定错误提示文本（模糊匹配可见文本）。',
    params: [{ name: 'string', type: 'string', description: '错误文案' }],
    examples: ['Then I should see the error "用户名或密码错误"'],
  },
  {
    moduleKey: MODULE_UI_FORM,
    name: 'ui-click',
    kind: 'builtin',
    pattern: 'I click {string}',
    description: '点击元素。参数为 role/文本/选择器之一，优先用可访问名称（如 "提交" 或 "button:has-text(\\"提交\\")"）。',
    params: [{ name: 'string', type: 'string', description: '元素文本或选择器' }],
    examples: ['When I click "提交"'],
  },
  {
    moduleKey: MODULE_UI_FORM,
    name: 'ui-fill',
    kind: 'builtin',
    pattern: 'I fill {string} with {string}',
    description: '向输入框填入值。第一个参数为元素文本或选择器，第二个为填入内容。',
    params: [
      { name: 'string', type: 'string', description: '输入框文本或选择器' },
      { name: 'string', type: 'string', description: '填入值' },
    ],
    examples: ['When I fill "留言" with "测试内容"'],
  },
  {
    moduleKey: MODULE_UI_ASSERT,
    name: 'ui-contains',
    kind: 'builtin',
    pattern: 'the page should contain {string}',
    description: '断言页面包含指定文本。',
    params: [{ name: 'string', type: 'string', description: '期望文本' }],
    examples: ['Then the page should contain "测试内容"'],
  },
  {
    moduleKey: MODULE_UI_ASSERT,
    name: 'ui-visible',
    kind: 'builtin',
    pattern: 'the element {string} should be visible',
    description: '断言指定元素可见（文本或选择器）。',
    params: [{ name: 'string', type: 'string', description: '元素文本或选择器' }],
    examples: ['Then the element "留言列表" should be visible'],
  },
  {
    moduleKey: MODULE_API,
    name: 'send-json-request',
    kind: 'api',
    pattern: 'I send a {method} request to {string} with JSON:',
    description: '发送 JSON 请求，请求体放在步骤下方的 docstring（""" 块）中。路径相对 apiBaseUrl。',
    params: [
      { name: 'method', type: 'method', description: 'HTTP 方法' },
      { name: 'string', type: 'string', description: '接口路径' },
    ],
    examples: [
      'When I send a POST request to "/api/login" with JSON:\n  """\n  {"username":"a","password":"b"}\n  """',
    ],
  },
  {
    moduleKey: MODULE_API,
    name: 'send-encrypted-json-request',
    kind: 'api',
    pattern: 'I send a {method} request to {string} with encrypted JSON:',
    description:
      '发送加密 JSON 请求：docstring 内写明文 JSON，runner 按约定协议（供口令派生 AES-256-CBC）加密后发送。',
    params: [
      { name: 'method', type: 'method', description: 'HTTP 方法' },
      { name: 'string', type: 'string', description: '接口路径' },
    ],
    examples: [
      'When I send a POST request to "/api/messages" with encrypted JSON:\n  """\n  {"text":"测试留言"}\n  """',
    ],
  },
  {
    moduleKey: MODULE_API,
    name: 'decrypt-response',
    kind: 'api',
    pattern: 'I decrypt the response payload',
    description: '解密上一个响应的 enc 字段，并用明文替换响应体，供后续 response 断言直接读取。',
    examples: ['Then I decrypt the response payload'],
  },
  {
    moduleKey: MODULE_API,
    name: 'send-request',
    kind: 'api',
    pattern: 'I send a {method} request to {string}',
    description: '发送无请求体的请求（GET/DELETE 等）。路径相对 apiBaseUrl。',
    params: [
      { name: 'method', type: 'method', description: 'HTTP 方法' },
      { name: 'string', type: 'string', description: '接口路径（可含查询参数）' },
    ],
    examples: ['When I send a GET request to "/api/messages?limit=10"'],
  },
  {
    moduleKey: MODULE_API,
    name: 'set-header',
    kind: 'api',
    pattern: 'I set header {string} to {string}',
    description: '设置后续请求的请求头，如鉴权头。',
    params: [
      { name: 'string', type: 'string', description: '请求头名' },
      { name: 'string', type: 'string', description: '请求头值' },
    ],
    examples: ['And I set header "Authorization" to "Bearer {{var.token}}"'],
  },
  {
    moduleKey: MODULE_API,
    name: 'store-response-field',
    kind: 'api',
    pattern: 'I store the response field {jsonPath} as {string}',
    description: '用 JSONPath 从响应体中取值并存入变量 {{var.<name>}}，供后续步骤引用。',
    params: [
      { name: 'jsonPath', type: 'jsonPath', description: 'JSONPath，如 $.token' },
      { name: 'string', type: 'string', description: '变量名' },
    ],
    examples: ['And I store the response field $.token as token'],
  },
  {
    moduleKey: MODULE_API_ASSERT,
    name: 'response-status',
    kind: 'api',
    pattern: 'the response status should be {int}',
    description: '断言响应状态码。',
    params: [{ name: 'int', type: 'int', description: '期望状态码' }],
    examples: ['Then the response status should be 200'],
  },
  {
    moduleKey: MODULE_API_ASSERT,
    name: 'response-time',
    kind: 'api',
    pattern: 'the response time should be less than {int} milliseconds',
    description: '断言响应耗时小于给定毫秒数。',
    params: [{ name: 'int', type: 'int', description: '毫秒阈值' }],
    examples: ['And the response time should be less than 2000 milliseconds'],
  },
  {
    moduleKey: MODULE_API_ASSERT,
    name: 'response-json-schema',
    kind: 'api',
    pattern: 'the response body should match JSON Schema {string}',
    description: '用 suite 内 JSON Schema 文件（相对路径）校验响应体。',
    params: [{ name: 'string', type: 'string', description: 'schema 文件路径' }],
    examples: ['And the response body should match JSON Schema "schemas/messages.json"'],
  },
  {
    moduleKey: MODULE_API_ASSERT,
    name: 'response-jsonpath',
    kind: 'api',
    pattern: 'the response body at {jsonPath} should be {string}',
    description: '断言响应体 JSONPath 处的值等于期望值（字符串比较，数字按字面比较）。',
    params: [
      { name: 'jsonPath', type: 'jsonPath', description: 'JSONPath，如 $.page' },
      { name: 'string', type: 'string', description: '期望值' },
    ],
    examples: ['And the response body at $.page should be 1'],
  },
  {
    moduleKey: MODULE_API_ASSERT,
    name: 'response-header',
    kind: 'api',
    pattern: 'the response header {string} should be {string}',
    description: '断言响应头取值。',
    params: [
      { name: 'string', type: 'string', description: '响应头名' },
      { name: 'string', type: 'string', description: '期望值' },
    ],
    examples: ['And the response header "content-type" should be "application/json"'],
  },
  {
    moduleKey: MODULE_API_ASSERT,
    name: 'response-error-code',
    kind: 'api',
    pattern: 'the response body should contain error code {string}',
    description: '断言响应体中的错误码字段等于给定值。',
    params: [{ name: 'string', type: 'string', description: '错误码' }],
    examples: ['And the response body should contain error code "TITLE_REQUIRED"'],
  },
  {
    moduleKey: MODULE_DB,
    name: 'test-database-prepared',
    kind: 'db',
    pattern: 'the test database is prepared',
    description: '重置测试数据库到基线（清理业务表并写入基线数据），通常写在 Background。',
    examples: ['Given the test database is prepared'],
  },
  {
    moduleKey: MODULE_DB,
    name: 'db-empty',
    kind: 'db',
    pattern: 'the database table {string} is empty',
    description: '断言指定表为空。',
    params: [{ name: 'string', type: 'string', description: '表名' }],
    examples: ['Then the database table messages is empty'],
  },
  {
    moduleKey: MODULE_DB,
    name: 'db-row-count-where',
    kind: 'db',
    pattern: 'the database table {string} should have {int} row(s) where {string} = {string}',
    description:
      '断言表中满足条件的行数。单复数均可（row / rows），表名与列值可不加引号。',
    params: [
      { name: 'string', type: 'string', description: '表名' },
      { name: 'int', type: 'int', description: '行数' },
      { name: 'string', type: 'string', description: '列名' },
      { name: 'string', type: 'string', description: '列值' },
    ],
    examples: [
      'Then the database table messages should have 1 row where text = "测试留言"',
      'Then the database table messages should have 2 rows where text = "测试留言"',
    ],
  },
  {
    moduleKey: MODULE_DB,
    name: 'db-row-count',
    kind: 'db',
    pattern: 'the database table {string} should have {int} row(s)',
    description:
      '断言整表行数。单复数均可；期望值大于当前值时 runner 自动造数补齐（已知表 messages）。',
    params: [
      { name: 'string', type: 'string', description: '表名' },
      { name: 'int', type: 'int', description: '行数' },
    ],
    examples: [
      'Then the database table messages should have 1 row',
      'Then the database table messages should have 1000 rows',
    ],
  },
  {
    moduleKey: MODULE_DB,
    name: 'db-query-row-count',
    kind: 'db',
    pattern: 'the database query {string} should return {int} rows',
    description: '执行只读 SQL 并断言行数。SQL 放 docstring 或作为第一个参数。',
    params: [
      { name: 'string', type: 'string', description: 'SELECT 语句' },
      { name: 'int', type: 'int', description: '行数' },
    ],
    examples: ['Then the database query "SELECT * FROM messages WHERE text = \'x\'" should return 1 rows'],
  },
  {
    moduleKey: MODULE_DB,
    name: 'db-raw-query-row-count',
    kind: 'db',
    pattern: 'the raw SQL {anything} should return {int} rows',
    description:
      '直接执行裸 SQL 并断言行数。SQL 不需要加引号，适合内含单引号的 WHERE 条件（如 text = \'x\'）。',
    params: [
      { name: 'anything', type: 'anything', description: '完整 SELECT 语句' },
      { name: 'int', type: 'int', description: '期望行数' },
    ],
    examples: [
      'Then the raw SQL SELECT text FROM messages WHERE text = \'留言\' should return 1 rows',
    ],
  },
  {
    moduleKey: MODULE_DB,
    name: 'db-delete-where',
    kind: 'db',
    pattern: 'I clean up the database rows in {string} where {string} = {string}',
    description: '按条件删除本用例自己的数据行。并发执行时不能清全表，但清理自己的标记数据是安全的，可用于让用例可重复执行。',
    params: [
      { name: 'string', type: 'string', description: '表名' },
      { name: 'string', type: 'string', description: '列名' },
      { name: 'string', type: 'string', description: '列值' },
    ],
    examples: [
      'Given I clean up the database rows in messages where text = "留言-create-001"',
    ],
  },
  {
    moduleKey: MODULE_DB,
    name: 'db-query-contains',
    kind: 'db',
    pattern: 'the database query {string} should contain {string}',
    description: '执行只读 SQL 并断言结果中包含指定值。',
    params: [
      { name: 'string', type: 'string', description: 'SELECT 语句' },
      { name: 'string', type: 'string', description: '期望值' },
    ],
    examples: ['Then the database query "SELECT text FROM messages" should contain "测试留言"'],
  },
  {
    moduleKey: MODULE_COMMON,
    name: 'agent-step',
    kind: 'agent',
    pattern: '[agent] {anything}',
    description:
      '兜底步骤：用自然语言描述一个操作，由 LLM 推断具体请求/操作。仅在无法用其他显式步骤表达时使用，禁止滥用。',
    params: [{ name: 'anything', type: 'anything', description: '自然语言指令' }],
    examples: ['When [agent] 发送一条内容为"测试留言"的留言'],
  },
];
