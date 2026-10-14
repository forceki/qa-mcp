# Spec: Login flow (example)

Target: https://the-internet.herokuapp.com/login (public demo site)

## Instructions for the QA agent
Run each step with the `qa_*` tools. If a selector fails, call `qa_inspect_dom`, fix the selector, and retry. Finish with `qa_finish_session`.

## Steps
1. `qa_start_session` with test_name `login-example`.
2. `qa_navigate` to `https://the-internet.herokuapp.com/login` — "Open login page".
3. `qa_assert` `text_present` "Login Page" — "Login page heading is shown".
4. `qa_action` fill `#username` with `tomsmith` — "Enter username".
5. `qa_action` fill `#password` with `SuperSecretPassword!` — "Enter password".
6. `qa_action` click `button[type=submit]` — "Submit the form".
7. `qa_assert` `url_matches` `/secure` — "Redirected to secure area".
8. `qa_assert` `text_present` "You logged into a secure area!" — "Success flash message".
9. `qa_assert` `element_visible` `a[href="/logout"]` — "Logout link visible".
10. `qa_finish_session` with summary notes.

## Expected result
All steps PASS; `result/login-example-<timestamp>/README.md` embeds 8 screenshots.
