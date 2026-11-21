# Reviewing a team branch before integration

From the repository root, fetch the current branches and inspect the proposed changes. This example compares the integrated demo with the default branch.

```sh
git fetch origin
git log --oneline origin/main..origin/demo-integrated
git diff --stat origin/main...origin/demo-integrated
```

The log shows commits reachable from the demo branch that are missing from main. The diff compares the demo branch with its common ancestor with main. Replace `demo-integrated` with the feature branch under review.

For changes that affect both camera capture and the assistant, test the handoff. Pair Camera A, verify its live preview, then ask about a visible object. Record the tested commit and the observed result in the pull request so another teammate can reproduce the check.
