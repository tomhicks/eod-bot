import { Anthropic } from "@anthropic-ai/sdk";
import { Issue, LinearClient } from "@linear/sdk";
import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { config } from "dotenv";
import { google } from "googleapis";

// Load environment variables
config();

interface PullRequestActivity {
  source: "pull request";
  type: "created" | "updated" | "merged";
  url: string;
  title: string;
  number: number;
  repo: string;
  linearIssue?: Issue;
  description: string | undefined;
  commits: Array<{
    message: string;
    timestamp: Date;
  }>;
  status: string;
  reviewStatus?: "approved" | "changes_requested" | "commented" | null;
  lastUpdated: Date;
}

interface LinearActivity {
  source: "linear";
  url: string;
  type: "created" | "statusChanged" | "commented" | "closed";
  date: string;
  ticketId: string;
  title: string;
  description?: string;
  prActivity?: PullRequestActivity;
}

interface CalendarEvent {
  title: string;
  startTime: Date;
  endTime: Date;
  attendees: number;
}

// Define the expected structure of the GraphQL query result
interface PullRequestNode {
  title: string;
  number: number;
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  body: string;
  headRefName: string;
  commits: {
    nodes: Array<{
      commit: {
        message: string;
        oid: string;
        authoredDate: string;
        author: {
          email: string;
          name: string;
        };
      };
    }>;
  };
  state: string;
  reviews: {
    nodes: Array<{
      state: string;
      author: {
        login: string;
      };
    }>;
  };
  updatedAt: string;
  createdAt: string;
  mergedAt: string | null;
}

interface PullRequestQueryResult {
  search: {
    nodes: PullRequestNode[];
  };
}

export class DailySummaryGenerator {
  private octokit: Octokit;
  private graphqlWithAuth: typeof graphql;
  private linear: LinearClient;
  private calendar: any; // Google Calendar API client
  private anthropic: Anthropic;

  constructor() {
    // Initialize API clients
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    this.graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${process.env.GITHUB_TOKEN}`,
      },
    });

    this.linear = new LinearClient({
      apiKey: process.env.LINEAR_API_KEY,
    });

    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    // Initialize Google Calendar
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });
    this.calendar = google.calendar({ version: "v3", auth });
  }

  private async getPullRequestActivities(
    date: Date
  ): Promise<PullRequestActivity[]> {
    const { username, name } = await this.getCurrentGithubUser();
    const dateString = date.toISOString().split("T")[0];

    // GraphQL query to get all PR activity for the day
    const query = `
      query {
        search(query: "author:${username} sort:updated-desc", type: ISSUE, first: 20) {
          nodes {
            ... on PullRequest {
              title
              number
              body
              repository { 
                name
                owner {
                  login
                }
              }
              headRefName
              commits(last: 100) {
                nodes {
                  commit {
                    message
                    oid
                    authoredDate
                    author {
                      email
                      name
                    }
                  }
                }
              }
              state
              reviews(last: 10) {
                nodes {
                  state
                  author {
                    login
                  }
                }
              }
              updatedAt
              createdAt
              mergedAt
            }
          }
        }
      }
    `;

    const result = await this.graphqlWithAuth<PullRequestQueryResult>(query, {
      username,
      date: dateString,
    });

    const prActivities: PullRequestActivity[] = [];

    const startOfDay = new Date(dateString);
    const endOfDay = new Date(dateString);
    endOfDay.setHours(23, 59, 59, 999);

    for (const pr of result.search.nodes) {
      // Only process PRs that were created, updated, or merged on this day
      const createdDate = new Date(pr.createdAt);
      const updatedDate = new Date(pr.updatedAt);
      const mergedDate = pr.mergedAt ? new Date(pr.mergedAt) : null;

      if (
        !this.isSameDay(createdDate, startOfDay) &&
        !this.isSameDay(updatedDate, startOfDay) &&
        !mergedDate
      ) {
        console.log("Skipping PR", pr.title);
        continue;
      }

      // Filter commits to only include those:
      // 1. Made by the current user
      // 2. Made on the specified date
      const relevantCommits = pr.commits.nodes
        .filter((commit: any) => {
          const commitDate = new Date(commit.commit.authoredDate);
          const isAuthor =
            commit.commit.author.email === username ||
            commit.commit.author.name === username ||
            commit.commit.author.name === name;

          return isAuthor && this.isSameDay(commitDate, startOfDay);
        })
        .map((commit: any) => ({
          message: commit.commit.message,
          timestamp: new Date(commit.commit.authoredDate),
        }));

      if (!relevantCommits.length) {
        continue;
      }

      // Get the most recent review status
      const latestReview = pr.reviews.nodes
        .sort(
          (a: any, b: any) =>
            new Date(b.submittedAt).getTime() -
            new Date(a.submittedAt).getTime()
        )
        .find((review: any) => review.author.login !== username);

      // Determine the type of activity
      let type: "created" | "updated" | "merged";
      if (this.isSameDay(createdDate, startOfDay)) {
        type = "created";
      } else if (mergedDate && this.isSameDay(mergedDate, startOfDay)) {
        type = "merged";
      } else {
        type = "updated";
      }

      let linearIssue: Issue | undefined = undefined;

      // Look for Linear ticket references in the branch name, PR title, or commit messages
      const branchNameMatch = pr.headRefName.match(/[A-Za-z]+-\d+/);
      const titleMatch = pr.title.match(/[A-Za-z]+-\d+/);
      const commitMessageMatch = pr.commits.nodes.some((commit: any) =>
        commit.commit.message.match(/[A-Za-z]+-\d+/)
      );

      const ticketMatch = branchNameMatch || titleMatch || commitMessageMatch;

      if (ticketMatch && Array.isArray(ticketMatch)) {
        const firstMatch = ticketMatch[0];
        try {
          const ticket = await this.linear.issue(firstMatch);

          // Assign Linear context to the PR
          linearIssue = ticket;
        } catch (error) {
          console.error(`Failed to fetch Linear context for ${firstMatch}`);
        }
      }

      prActivities.push({
        source: "pull request",
        type,
        url: `https://github.com/${pr.repository.owner.login}/${pr.repository.name}/pull/${pr.number}`,
        title: pr.title,
        number: pr.number,
        description: pr.body.trim().startsWith("##")
          ? pr.body
              .trim()
              .split("<!-- BEGIN_FRONTEND_CHECKLIST_CONTENT -->")[0]
              .split("Test plan")[0]
          : undefined,
        repo: `${pr.repository.owner.login}/${pr.repository.name}`,
        commits: relevantCommits,
        status: pr.state.toLowerCase(),
        reviewStatus: this.mapReviewState(latestReview?.state) || null,
        lastUpdated: updatedDate,
        linearIssue,
      });
    }

    return prActivities;
  }

  private isSameDay(date1: Date, date2: Date): boolean {
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  }

  private async getLinearActivities(date: Date): Promise<LinearActivity[]> {
    console.log("Getting Linear activities for", date);
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    const activities: LinearActivity[] = [];

    // Get user's Linear ID
    const me = await this.linear.viewer;

    // Fetch issues created/updated by user
    const issues = await this.linear.issues({
      filter: {
        creator: { id: { eq: me.id } },
        createdAt: { gte: startOfDay, lte: endOfDay },
      },
    });

    // Get all comments made in the last day
    const comments = await this.linear.comments({
      filter: {
        createdAt: { gte: date, lte: endOfDay },
        and: [
          {
            user: {
              id: { eq: me.id },
            },
          },
        ],
      },
    });

    // Filter comments to only include those made by the current user
    const userComments = (
      await Promise.all(
        comments.nodes.map(async (comment) => {
          const [issue, user] = await Promise.all([
            comment.issue,
            comment.user,
          ]);
          return {
            ...comment,
            issue,
            user,
          };
        })
      )
    )
      // Filter out comments that are too short to be useful
      .filter((c) => c.body.length > 100);

    // Add comment activities
    for (const comment of userComments) {
      const issue = await comment.issue;

      activities.push({
        source: "linear",
        url: comment.issue?.url ?? "",
        type: "commented",
        ticketId: issue?.identifier ?? "",
        title: issue?.title ?? "",
        date: comment.createdAt.toISOString(),
        description: comment.body,
      });
    }

    for (const issue of issues.nodes) {
      activities.push({
        source: "linear",
        type: "created",
        url: issue.url,
        ticketId: issue.identifier,
        date: issue.updatedAt.toISOString(),
        title: issue.title,
      });
    }

    // sort the activities by date
    activities.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    return activities;
  }

  private async getCalendarEvents(date: Date): Promise<CalendarEvent[]> {
    const timeMin = new Date(date);
    timeMin.setHours(0, 0, 0, 0);
    const timeMax = new Date(date);
    timeMax.setHours(23, 59, 59, 999);

    const response = await this.calendar.events.list({
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
    });

    return response.data.items.map((event: any) => ({
      title: event.summary,
      startTime: new Date(event.start.dateTime),
      endTime: new Date(event.end.dateTime),
      attendees: event.attendees?.length ?? 0,
    }));
  }

  private groupPRAndLinearActivities(
    prActivities: PullRequestActivity[],
    linearActivities: LinearActivity[]
  ): {
    openedPRs: PullRequestActivity[];
    mergedPRs: PullRequestActivity[];
    linearIssues: LinearActivity[];
  } {
    const groupedActivities: Array<LinearActivity | PullRequestActivity> = [];
    for (const prActivity of prActivities) {
      groupedActivities.push(prActivity);
    }

    for (const linearActivity of linearActivities) {
      const prActivity = prActivities.find(
        (activity) =>
          activity.linearIssue?.identifier === linearActivity.ticketId
      );
      if (!prActivity) {
        groupedActivities.push(linearActivity);
      }
    }

    for (const prActivity of prActivities) {
      prActivity.linearIssue = undefined;
    }

    const result: {
      openedPRs: PullRequestActivity[];
      mergedPRs: PullRequestActivity[];
      linearIssues: LinearActivity[];
    } = {
      openedPRs: [],
      mergedPRs: [],
      linearIssues: [],
    };

    groupedActivities.forEach((activity) => {
      if (activity.source === "pull request") {
        if (activity.status === "merged") {
          result.mergedPRs.push(activity);
        } else if (activity.status === "open") {
          result.openedPRs.push(activity);
        }
      } else {
        result.linearIssues.push(activity);
      }
    });

    return result;
  }

  async generateSummary(
    date: Date,
    skipLLM: boolean = false
  ): Promise<{
    activities: ReturnType<
      typeof DailySummaryGenerator.prototype.groupPRAndLinearActivities
    >;
    response: string;
  }> {
    const [pullRequests, linearActivities] = await Promise.all([
      this.getPullRequestActivities(date),
      this.getLinearActivities(date),
      // this.getCalendarEvents(date),
    ]);

    const finalActivities = this.groupPRAndLinearActivities(
      pullRequests,
      linearActivities
    );

    // Skip LLM generation if requested
    if (skipLLM) {
      return {
        activities: finalActivities,
        response: "LLM summary generation skipped",
      };
    }

    // Generate natural language summary using Claude
    const response = await this.anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Please write a personal end-of-day summary based on the following activities. Focus on what I did and what happened, without value judgments.

          Keep the grouping where a Linear issue has a PR associated with it.

          Put each top-level activity in its own bullet point with a link to the activity formatted as a markdown link with the name of the activity as the link text.

          Summarise multiple commit messages into a single prose description of all the changes, starting like: "Made commits to...", **NOT** listing the commit messages.

          Structure the output like this:
          
          Opened PRs:
          - {repo name}: [PR title](PR URL)
            - summary of what the PR does if it has a description
            - details about the changes made and the PR itself
          - {repo name}: [PR title](PR URL)
            - summary of what the PR does if it has a description
            - details about the changes made and the PR itself

          Merged PRs:
          - {repo name}: [PR title](PR URL)
            - summary of what the PR does if it has a description
            - details about the changes made and the PR itself

          Linear:
          - [Linear issue title](Linear issue URL)
            - summarise the activity on the issue
          - [Linear issue title](Linear issue URL)
            - summarise the activity on the issue

          Activities: ${JSON.stringify(finalActivities, null, 2)}`,
        },
      ],
    });

    return {
      activities: finalActivities,
      response: response.content[0].text,
    };
  }

  private async getCurrentGithubUser(): Promise<{
    username: string;
    name: string;
  }> {
    const { data } = await this.octokit.users.getAuthenticated();
    return {
      username: data.login,
      name: data.name ?? "",
    };
  }

  private mapReviewState(
    state: string | undefined
  ): "approved" | "changes_requested" | "commented" | undefined {
    switch (state?.toLowerCase()) {
      case "approved":
      case "changes_requested":
      case "commented":
        return state as "approved" | "changes_requested" | "commented";
      default:
        return undefined;
    }
  }
}

export default DailySummaryGenerator;
