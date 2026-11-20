# language: en
# generated-by: git-ai-test-flow
# source-commit: c91a7f4

@module:posts @layer:api @risk:high @owner:qa
Feature: 帖子 API
  Background:
    Given the test database is prepared

  @case:POST-API-001 @smoke
  Scenario: 通过 API 创建帖子并落库
    Given the database table "posts" is empty
    When I send a POST request to "/api/posts" with JSON:
      """json
      {"title": "{{fixture.post.title}}", "body": "{{fixture.post.body}}"}
      """
    Then the response status should be 201
    And the response body should match JSON Schema "schemas/post.json"
    And the database table "posts" should have 1 row where "title" = "{{fixture.post.title}}"

  @case:POST-API-002 @regression
  Scenario: 标题为空时返回 400
    When I send a POST request to "/api/posts" with JSON:
      """json
      {"title": "", "body": "{{fixture.post.body}}"}
      """
    Then the response status should be 400
    And the response body should contain error code "TITLE_REQUIRED"
    And the database table "posts" should have 0 rows
