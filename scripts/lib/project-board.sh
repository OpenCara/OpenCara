#!/usr/bin/env bash
# Shared library: fetch all project board items with pagination.
# Sources this file, then call fetch_board_items to get all items as JSON.
# Uses ~2 GraphQL points per 100 items (vs ~203 for gh project item-list).

fetch_board_items() {
  local cursor=""
  local all_items="[]"
  local has_next="true"

  while [ "$has_next" = "true" ]; do
    local cursor_arg=""
    if [ -n "$cursor" ]; then
      cursor_arg="-f cursor=$cursor"
    fi

    local result
    result=$(gh api graphql -F owner=OpenCara -F number=1 $cursor_arg -f query='
      query($owner: String!, $number: Int!, $cursor: String) {
        organization(login: $owner) {
          projectV2(number: $number) {
            items(first: 100, after: $cursor) {
              nodes {
                content {
                  ... on Issue { number title }
                  ... on PullRequest { number title }
                }
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }')

    local page_items
    page_items=$(echo "$result" | jq '[.data.organization.projectV2.items.nodes[] | select(.content.number != null) | {number: .content.number, title: .content.title, status: .fieldValueByName.name}]')

    all_items=$(jq -n --argjson a "$all_items" --argjson b "$page_items" '$a + $b')

    has_next=$(echo "$result" | jq -r '.data.organization.projectV2.items.pageInfo.hasNextPage')
    cursor=$(echo "$result" | jq -r '.data.organization.projectV2.items.pageInfo.endCursor')
  done

  echo "$all_items"
}
