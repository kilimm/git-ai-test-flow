# language: en
# generated-by: git-ai-test-flow
# source-commit: 4f2c1a9

@module:auth @layer:ui @risk:high @owner:qa
Feature: 用户登录
  Background:
    Given the test environment is ready

  @case:AUTH-LOGIN-001 @smoke @template:login
  Scenario: 使用正确凭证登录
    Given I am on the "/login" page
    When I enter my username and password
    Then I should be redirected to the "/dashboard" page

  @case:AUTH-LOGIN-002 @regression
  Scenario: 使用错误密码登录
    Given I am on the "/login" page
    When I enter username "{{secret.testUser}}" and password "wrong-password"
    Then I should see the error "用户名或密码错误"
    And I should stay on the "/login" page
