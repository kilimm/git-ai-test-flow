# language: en
# generated-by: git-ai-test-flow
@module:posts @layer:ui
Feature: Posts UI

  @case:POST-UI-001
  Scenario: create and see a post
    Given I am on the "/" page
    When I fill "input[name=username]" with "{{secret.testAccount.username}}"
    And I fill "input[name=password]" with "{{secret.testAccount.password}}"
    And I click "button[data-testid=login-submit]"
    And I wait 500 milliseconds
    Then I should be redirected to the "/posts" page
    And the element "[data-testid=post-list]" should be visible

  @case:POST-UI-002
  Scenario: stale selector intentionally fails
    Given I am on the "/login" page
    When I enter my username and password
    And I wait 500 milliseconds
    Then the element ".posts-container" should be visible
