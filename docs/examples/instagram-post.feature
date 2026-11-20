# language: en
# generated-by: git-ai-test-flow
# source-commit: 8b3d5e2

@module:posts @layer:e2e @risk:medium @owner:qa
Feature: 创建帖子
  Background:
    Given the test environment is ready

  @case:POST-AGENT-001 @generated @agent
  Scenario: 作者发布一条关于近期新闻的帖子
    Given I am logged in as "author"
    When [agent] 生成一条关于近期 AI 新闻的帖子，并调用 publish_post 工具发布
    Then [agent] 我应该在帖子列表中看到这条关于 AI 新闻的帖子

  @case:POST-AGENT-002 @agent
  Scenario: 帖子内容为空时拒绝发布
    Given I am logged in as "author"
    When [agent] 尝试调用 publish_post 工具发布一条空内容的帖子
    Then [agent] 我应该看到发布失败并被提示内容不能为空
