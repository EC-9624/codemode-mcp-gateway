/** Synthetic tool metadata, not captured provider data. Order is fixed for baseline ties. */
export const searchCorpus = [
  {
    name: "billing.listPayments",
    description: "List customer payments and their associated invoices.",
  },
  {
    name: "billing.listInvoices",
    description: "List customer invoices with amounts, due dates, and payment status.",
  },
  {
    name: "billing.getInvoice",
    description: "Read a single invoice by identifier, including line items and customer details.",
  },
  {
    name: "billing.listCustomers",
    description: "List customer profiles and billing contact details.",
  },
  { name: "billing.listOverdue", description: "Find overdue invoices that have not been paid." },
  {
    name: "billing.refundPayment",
    description: "Refund a settled payment to the original payment method.",
  },
  {
    name: "billing.summary",
    description:
      "Produce an account summary for a customer. Includes invoice totals, overdue amounts, payment history, refund totals, and billing contacts. Use dedicated invoice and payment tools to inspect or change individual records rather than this summary.",
  },
  { name: "notion.searchPages", description: "Search workspace pages by title and content." },
  { name: "notion.fetchPage", description: "Fetch the complete content of a page by identifier." },
  {
    name: "notion.updatePage",
    description: "Update a page title, properties, or archived status after search and fetch.",
  },
  { name: "notion.createComment", description: "Add a discussion comment to a page." },
  {
    name: "notion.queryDatabase",
    description: "Query database records with property filters and sorting.",
  },
  { name: "workspace.inventory", description: "List workspace records and their owners." },
  {
    name: "workspace.audit",
    description:
      "Inspect workspace record activity, including webhook delivery history and access changes.",
  },
  { name: "hooks.subscribe", description: "Register a webhook for record changes in a workspace." },
  { name: "hooks.deliveries", description: "Inspect failed webhook deliveries and retry status." },
  {
    name: "github.listIssues",
    description: "List open repository issues with labels and assignees.",
  },
  {
    name: "github.createIssue",
    description: "Create a repository issue with a title and description.",
  },
  {
    name: "github.listPullRequests",
    description: "List pull requests awaiting review in a repository.",
  },
  {
    name: "github.getPullRequest",
    description: "Read pull request details, review comments, and checks.",
  },
  {
    name: "github.searchCode",
    description: "Search source code for symbols and text in repositories.",
  },
  {
    name: "slack.searchMessages",
    description: "Search messages by text, channel, sender, and date.",
  },
  { name: "slack.sendMessage", description: "Send a message to a channel or conversation." },
  { name: "slack.listChannels", description: "List public channels and their topics." },
  { name: "calendar.listEvents", description: "List calendar events within a time range." },
  {
    name: "calendar.createEvent",
    description: "Schedule a calendar event with attendees and a start time.",
  },
  {
    name: "calendar.freeBusy",
    description: "Find available meeting times by checking attendee availability.",
  },
  { name: "cloud.listBuckets", description: "List object storage buckets in an account." },
  {
    name: "cloud.rotateCredentials",
    description: "Rotate access credentials for a service account.",
  },
  {
    name: "cloud.inspectAccount",
    description:
      "Inspect a service account configuration, including access credentials, storage buckets, permissions, audit settings, and rotation history. This read-only report cannot rotate credentials or update permissions; use the appropriate action tool for those changes.",
  },
  {
    name: "network.readHTTPResponse",
    description: "Inspect HTTP response headers and status codes.",
  },
  { name: "mail.sendEmail", description: "Send an email message with a subject and recipients." },
  {
    name: "sync.inspect",
    description: "Check synchronization state and the time of the last completed run.",
  },
  { name: "places.lookup", description: "Find a cafe\u0301 nearby using a location and distance." },
  { name: "資料検索", description: "資料とドキュメントを検索します。" },
  {
    name: "crm.overview",
    description:
      "Read a customer activity overview with account details, usage history, and links to dedicated reports. Those reports predict retention risk and churn using additional signals. This overview is historical and does not generate predictions.",
  },
  {
    name: "crm.health",
    description: "Predict customer churn and retention risk from activity signals.",
  },
  {
    name: "ops.dashboard",
    description:
      "Read an operations dashboard with service status, recent deployments, traffic totals, and links to tracing tools that diagnose latency. The dashboard summarizes health but does not analyze individual slow requests or their causes.",
  },
  {
    name: "ops.trace",
    description: "Diagnose latency by analyzing slow requests and their causes.",
  },
  {
    name: "files.preview",
    description:
      "Show a file preview with its title, size, format, and thumbnail. For PDF text content, use the extraction tool to read the complete document. Previews do not include complete file contents or text from every page.",
  },
  { name: "files.extract", description: "Read complete PDF text content from every page." },
  {
    name: "identity.inspectUser",
    description:
      "Inspect a user profile, including account state, permissions, and sign-in history. This operation cannot revoke active sessions or change permissions. Use the deactivation tool to end access rather than reading this profile again.",
  },
  { name: "identity.deactivate", description: "Revoke active sessions and end a user's access." },
] as const;

export type SearchJudgment = {
  name: string;
  /** Paraphrases share one family for equally weighted intent-level metrics. */
  family?: string;
  query: string;
  /** 2 = directly relevant, 1 = useful alternative. Unlisted tools are irrelevant. */
  relevance: Readonly<Record<string, 1 | 2>>;
};

export const searchJudgments: readonly SearchJudgment[] = [
  {
    name: "customer invoices",
    query: "customer invoices",
    relevance: { "billing.listInvoices": 2, "billing.getInvoice": 1, "billing.listOverdue": 1 },
  },
  {
    name: "unpaid invoices",
    query: "find overdue invoices",
    relevance: { "billing.listOverdue": 2, "billing.listInvoices": 1 },
  },
  { name: "refund action", query: "refund payment", relevance: { "billing.refundPayment": 2 } },
  {
    name: "billing contacts",
    query: "customer contact details",
    relevance: { "billing.listCustomers": 2 },
  },
  {
    name: "separator query",
    query: "list-invoices",
    relevance: { "billing.listInvoices": 2, "billing.listOverdue": 1 },
  },
  {
    name: "exact qualified name",
    query: "billing.getInvoice",
    relevance: { "billing.getInvoice": 2 },
  },
  {
    name: "find workspace content",
    query: "search workspace pages",
    relevance: { "notion.searchPages": 2 },
  },
  {
    name: "read page content",
    query: "fetch complete page content",
    relevance: { "notion.fetchPage": 2 },
  },
  {
    name: "change page properties",
    query: "update page properties",
    relevance: { "notion.updatePage": 2 },
  },
  {
    name: "page discussion",
    query: "add discussion comment",
    relevance: { "notion.createComment": 2 },
  },
  {
    name: "filtered records",
    query: "database property filters sorting",
    relevance: { "notion.queryDatabase": 2 },
  },
  {
    name: "rare webhook intent",
    query: "workspace record webhook",
    relevance: { "hooks.subscribe": 2, "workspace.audit": 1 },
  },
  {
    name: "failed deliveries",
    query: "failed webhook deliveries",
    relevance: { "hooks.deliveries": 2, "workspace.audit": 1 },
  },
  {
    name: "open issues",
    query: "open repository issues labels",
    relevance: { "github.listIssues": 2 },
  },
  {
    name: "create issue",
    query: "create repository issue",
    relevance: { "github.createIssue": 2 },
  },
  {
    name: "pending reviews",
    query: "pull requests awaiting review",
    relevance: { "github.listPullRequests": 2, "github.getPullRequest": 1 },
  },
  {
    name: "source symbols",
    query: "search source code symbols",
    relevance: { "github.searchCode": 2 },
  },
  {
    name: "find conversations",
    query: "search messages sender date",
    relevance: { "slack.searchMessages": 2 },
  },
  { name: "post to channel", query: "send message channel", relevance: { "slack.sendMessage": 2 } },
  {
    name: "channel directory",
    query: "public channels topics",
    relevance: { "slack.listChannels": 2 },
  },
  {
    name: "schedule meeting",
    query: "schedule event attendees",
    relevance: { "calendar.createEvent": 2, "calendar.freeBusy": 1 },
  },
  {
    name: "meeting availability",
    query: "available meeting times",
    relevance: { "calendar.freeBusy": 2 },
  },
  {
    name: "storage inventory",
    query: "object storage buckets",
    relevance: { "cloud.listBuckets": 2 },
  },
  {
    name: "credential action not inspection",
    query: "rotate access credentials",
    relevance: { "cloud.rotateCredentials": 2 },
  },
  {
    name: "acronym separators",
    query: "http-response",
    relevance: { "network.readHTTPResponse": 2 },
  },
  { name: "underscore separators", query: "search_pages", relevance: { "notion.searchPages": 2 } },
  { name: "canonical Unicode", query: "café", relevance: { "places.lookup": 2 } },
  { name: "non-Latin substring", query: "資料", relevance: { 資料検索: 2 } },
  { name: "partial tool name", query: "mail", relevance: { "mail.sendEmail": 2 } },
  { name: "partial description", query: "chron", relevance: { "sync.inspect": 2 } },
  {
    name: "repeated case-insensitive terms",
    family: "customer invoices",
    query: "CUSTOMER invoices customer",
    relevance: { "billing.listInvoices": 2, "billing.getInvoice": 1, "billing.listOverdue": 1 },
  },
  {
    name: "prediction not an overview mentioning predictions",
    query: "predict retention risk",
    relevance: { "crm.health": 2 },
  },
  {
    name: "rare churn intent",
    query: "customer activity churn",
    relevance: { "crm.health": 2, "crm.overview": 1 },
  },
  {
    name: "diagnosis not a dashboard linking to it",
    query: "diagnose latency",
    relevance: { "ops.trace": 2, "ops.dashboard": 1 },
  },
  {
    name: "complete extraction not a preview",
    query: "PDF text content",
    relevance: { "files.extract": 2 },
  },
  {
    name: "revocation not a profile mentioning revocation",
    query: "revoke active sessions",
    relevance: { "identity.deactivate": 2 },
  },
  { name: "no matching capability", query: "qzxv nonexistent", relevance: {} },
  { name: "blank query", query: "  ", relevance: {} },
];
