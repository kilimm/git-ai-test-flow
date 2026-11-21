# language: en
# generated-by: git-ai-test-flow
@module:posts @layer:api
Feature: Posts API

  Background:
    When I send a POST request to "/api/login" with JSON:
      """
      {"username":"{{env.DEMO_USERNAME}}","password":"{{env.DEMO_PASSWORD}}"}
      """
    Then the response status should be 200
    And I store the response field $.token as token
    And I set header "Authorization" to "Bearer {{var.token}}"

  @case:POST-API-001
  Scenario: list posts with pagination
    When I send a GET request to "/api/posts?page=1&pageSize=10"
    Then the response status should be 200
    And the response time should be less than 2000 milliseconds
    And the response body at $.page should be 1
    And the response body at $.pageSize should be 10

  @case:POST-API-002
  Scenario: empty title is rejected
    When I send a POST request to "/api/posts" with JSON:
      """
      {"title":""}
      """
    Then the response status should be 400
    And the response body should contain error code "TITLE_REQUIRED"
