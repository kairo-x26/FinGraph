# User guide

FinGraph helps your team collect a customer's documents, check what they say, see
who owns and controls the business, and record a decision that auditors can
reconstruct later. FinGraph proposes; people decide.

## Signing in

Go to your FinGraph address, enter your organization's short name and choose
**Continue with single sign-on**. You sign in with your company account. If your
organization requires multi-factor authentication, enroll a second factor with
your identity provider first. You are signed out after a period of inactivity.

## Roles at a glance

| Role | Typical work |
|---|---|
| Onboarding specialist | Opens cases, uploads or imports documents, chases missing documents |
| Compliance analyst | Reviews extracted fields and relationships, asks questions, records a decision |
| Risk manager | Approves escalated and high-risk cases, edits review policies and checklists |
| Internal auditor | Reads cases, decisions and the audit log, creates evidence packages |
| Administrator | Manages people, sign-in rules, integrations, retention and legal holds |
| Integration developer | Manages API clients and webhooks |

## Onboarding specialist

1. **Open a case.** Choose **New case** on the Cases page. Enter the customer's
   legal name, the case type and the risk level, and optionally a reviewer.
2. **Add documents.** Open the case, go to **Evidence** and drop files onto the
   upload area. PDFs, images, Word and text files are accepted. Processing usually
   takes seconds:
   - a file the scanner flags is **Quarantined** and cannot be opened;
   - a file whose content does not match its type is refused;
   - uploading the same file twice in a case links to the existing copy.
3. **Import from a repository.** Under **Administration → Integrations**, choose
   **Import files** on a connected repository, pick the case and the files.
4. **Track what is missing.** The **Overview** tab lists required documents. Use
   **Request** to record what you asked the customer for.

## Compliance analyst

1. **Pick up work.** Cases → **Assigned to me**, or **Unassigned** → open a case →
   **Assign to me**, then **Start review**.
2. **Read the findings.** **Overview** shows policy checks and findings: undeclared
   beneficial owners, conflicting percentages, mismatched identifiers, missing or
   out-of-date documents.
3. **Review fields.** In **Evidence**, select a document. Select a field on the left
   to see the highlighted words in the source page on the right. Then:
   - **Approve** (✓) when the value matches the source;
   - **Edit** to correct it, with a short reason (the original value is kept);
   - **Reject** (✕) when the value is wrong or irrelevant, with a reason.
   Fields marked *critical* must all be reviewed before the case can be approved.
4. **Check relationships.** **Relationships** draws owners above what they own and
   officers below the company. Dashed lines are proposals from documents; solid
   green lines are verified. Select a line to read the supporting text, then
   **Verify relationship** or **Reject** it with a reason.
5. **Ask questions.** **Ask** answers questions from the documents you can open.
   Each statement has numbered sources; select one to open the page with the
   passage highlighted. *Not enough evidence* is a valid answer: it means the
   documents do not say. A red banner means a document tried to instruct the AI and
   was left out.
6. **Decide.** Choose **Submit decision**, pick approve or reject and write your
   rationale. Depending on your organization's policy and the findings, the case
   closes, goes to an approver, or is escalated to a risk manager. Use **Request
   information** to pause the review while the customer sends more documents.

## Risk manager

- **Awaiting approval** on the Cases page lists cases waiting for a second person.
  You cannot approve a case you reviewed yourself.
- Open the case, read the decision history and findings, then choose **Decide**:
  approve, reject, or return it to the reviewer with comments.
- **Administration → Policies** lets you publish new versions of the review policy
  (beneficial-ownership threshold, escalation triggers, blocking findings, second
  approval by risk level) and of the required-document checklists. Open cases keep
  the version they started with.
- The **Dashboard** shows workload, overdue cases, throughput, review time and
  processing exceptions.

## Internal auditor

- Every case has **Decisions** (who decided what, why, and under which policy
  version) and **Activity** (the case's audit trail).
- **Exports → Create evidence package** builds a ZIP with the case record,
  documents, reviewed fields with their history, relationships with evidence,
  decisions, AI questions and the audit trail. Every file is listed with its
  SHA-256 in `manifest.json`. If your organization requires it, a second person
  approves the export before it is built.
- **Share** creates a link that expires after 72 hours and allows three downloads.
  Each download is logged.
- **Audit log** shows every recorded action and checks that the log has not been
  altered ("Integrity verified").

## Administrator

- **People:** invite people with roles (they become active the first time they sign
  in), change roles (takes effect immediately), deactivate (signs them out
  everywhere), or set up automatic provisioning from your identity provider (SCIM).
- **Organization:** require MFA, set session timeouts, allowed email domains and
  networks, how long closed cases are kept, whether exports need approval, and
  daily limits. Connect your own identity provider.
- **Integrations:** connect a document repository with read-only access, and
  disconnect it at any time.
- **Governance:** place and release legal holds, see cases due for deletion, and
  check background processing health.

## Integration developer

**Administration → Developers** creates API clients (OAuth client credentials) and
webhooks. Secrets are shown once. Webhook deliveries can be inspected and sent
again. See [API.md](API.md).

## Good practice

- Treat every AI answer as a pointer to evidence. Open the source before relying on it.
- Write rationales that a stranger could follow a year from now.
- Do not upload documents that are not part of the customer's file.
- Report anything unexpected (a document you should not see, a strange answer)
  with the reference number shown on the page.
