#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const TOGGL_API_KEY = process.env.TOGGL_API_KEY;

if (!TOGGL_API_KEY) {
  console.error("Error: TOGGL_API_KEY environment variable is required");
  console.error("Get your API key from: https://track.toggl.com/profile");
  process.exit(1);
}

class TogglClient {
  private api: AxiosInstance;
  private workspaceId?: number;

  constructor(apiKey: string) {
    this.api = axios.create({
      baseURL: "https://api.track.toggl.com/api/v9",
      auth: {
        username: apiKey,
        password: "api_token",
      },
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  async getWorkspaceId(): Promise<number> {
    if (this.workspaceId) return this.workspaceId;

    const response = await this.api.get("/me");
    this.workspaceId = response.data.default_workspace_id;
    return this.workspaceId!;
  }

  async getCurrentEntry() {
    const response = await this.api.get("/me/time_entries/current");
    return response.data;
  }

  async startTimer(description: string, projectId?: number) {
    const workspaceId = await this.getWorkspaceId();
    const data = {
      created_with: "toggl-mcp",
      description,
      workspace_id: workspaceId,
      project_id: projectId,
      start: new Date().toISOString(),
      duration: -1,
    };

    const response = await this.api.post(`/workspaces/${workspaceId}/time_entries`, data);
    return response.data;
  }

  async stopTimer() {
    const current = await this.getCurrentEntry();
    if (!current) {
      throw new Error("No timer is currently running");
    }

    const workspaceId = await this.getWorkspaceId();
    const response = await this.api.patch(
      `/workspaces/${workspaceId}/time_entries/${current.id}/stop`
    );
    return response.data;
  }

  async getTodayEntries() {
    const workspaceId = await this.getWorkspaceId();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const response = await this.api.get("/me/time_entries", {
      params: {
        start_date: today.toISOString(),
        end_date: new Date().toISOString(),
      },
    });

    return response.data;
  }

  async getProjects() {
    const workspaceId = await this.getWorkspaceId();
    const response = await this.api.get(`/workspaces/${workspaceId}/projects`);
    return response.data;
  }

  async deleteEntry(entryId: number) {
    const workspaceId = await this.getWorkspaceId();
    await this.api.delete(`/workspaces/${workspaceId}/time_entries/${entryId}`);
    return { success: true, message: `Deleted entry ${entryId}` };
  }
}

const StartTimerSchema = z.object({
  description: z.string().describe("Description of the task"),
  project_name: z.string().optional().describe("Optional project name"),
});

const DeleteEntrySchema = z.object({
  entry_id: z.number().describe("ID of the time entry to delete"),
});

async function main() {
  const client = new TogglClient(TOGGL_API_KEY!);
  const server = new Server({
    name: "toggl-mcp",
    version: "0.1.0",
  }, {
    capabilities: {
      tools: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "toggl_start",
        description: "Start a new time tracking entry",
        inputSchema: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Description of the task",
            },
            project_name: {
              type: "string",
              description: "Optional project name",
            },
          },
          required: ["description"],
        },
      },
      {
        name: "toggl_stop",
        description: "Stop the currently running timer",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "toggl_current",
        description: "Get the currently running time entry",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "toggl_today",
        description: "Get today's time entries with total duration",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "toggl_projects",
        description: "List all projects in the workspace",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "toggl_delete",
        description: "Delete a time entry by ID",
        inputSchema: {
          type: "object",
          properties: {
            entry_id: {
              type: "number",
              description: "ID of the time entry to delete",
            },
          },
          required: ["entry_id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    try {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "toggl_start": {
          const { description, project_name } = StartTimerSchema.parse(args);

          let projectId: number | undefined;
          if (project_name) {
            const projects = await client.getProjects();
            const project = projects.find(
              (p: any) => p.name.toLowerCase() === project_name.toLowerCase()
            );
            projectId = project?.id;
          }

          const entry = await client.startTimer(description, projectId);
          return {
            content: [
              {
                type: "text",
                text: `Started timer: "${description}"${
                  project_name ? ` on project "${project_name}"` : ""
                }\nEntry ID: ${entry.id}`,
              },
            ],
          };
        }

        case "toggl_stop": {
          const entry = await client.stopTimer();
          const duration = Math.abs(entry.duration);
          const hours = Math.floor(duration / 3600);
          const minutes = Math.floor((duration % 3600) / 60);

          return {
            content: [
              {
                type: "text",
                text: `Stopped timer: "${entry.description}"\nDuration: ${hours}h ${minutes}m`,
              },
            ],
          };
        }

        case "toggl_current": {
          const current = await client.getCurrentEntry();

          if (!current) {
            return {
              content: [
                {
                  type: "text",
                  text: "No timer is currently running",
                },
              ],
            };
          }

          const duration = Math.abs(current.duration + Math.floor(Date.now() / 1000));
          const hours = Math.floor(duration / 3600);
          const minutes = Math.floor((duration % 3600) / 60);

          return {
            content: [
              {
                type: "text",
                text: `Currently tracking: "${current.description}"\nRunning for: ${hours}h ${minutes}m`,
              },
            ],
          };
        }

        case "toggl_today": {
          const entries = await client.getTodayEntries();

          if (!entries || entries.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No time entries today",
                },
              ],
            };
          }

          const totalSeconds = entries.reduce((sum: number, entry: any) => {
            return sum + Math.abs(entry.duration);
          }, 0);

          const totalHours = Math.floor(totalSeconds / 3600);
          const totalMinutes = Math.floor((totalSeconds % 3600) / 60);

          const entryList = entries
            .map((e: any) => {
              const duration = Math.abs(e.duration);
              const h = Math.floor(duration / 3600);
              const m = Math.floor((duration % 3600) / 60);
              return `- ${e.description || "No description"} (${h}h ${m}m)`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Today's entries:\n${entryList}\n\nTotal: ${totalHours}h ${totalMinutes}m`,
              },
            ],
          };
        }

        case "toggl_projects": {
          const projects = await client.getProjects();

          if (!projects || projects.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No projects found",
                },
              ],
            };
          }

          const projectList = projects
            .map((p: any) => `- ${p.name} (ID: ${p.id})`)
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Projects:\n${projectList}`,
              },
            ],
          };
        }

        case "toggl_delete": {
          const { entry_id } = DeleteEntrySchema.parse(args);
          const result = await client.deleteEntry(entry_id);

          return {
            content: [
              {
                type: "text",
                text: result.message,
              },
            ],
          };
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid parameters: ${error.errors.map((e) => e.message).join(", ")}`
        );
      }

      if (error.response?.status === 401) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Invalid Toggl API key. Check your TOGGL_API_KEY environment variable."
        );
      }

      throw new McpError(
        ErrorCode.InternalError,
        error.message || "An unexpected error occurred"
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Toggl MCP server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});