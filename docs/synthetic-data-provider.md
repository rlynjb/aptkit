# Synthetic Data Provider

This package adds a reusable ecommerce analytics data source that agents can consume through normal AptKit tools. It is intended as the AptKit-side replacement path for external demo data servers such as an Olist MCP server, without changing Blooming Insights yet.

## Package

`@aptkit/provider-synthetic` exposes:

- `FixtureSyntheticEcommerceDataSource`: deterministic synthetic ecommerce workspace data for tests, Studio, and repeatable demos.
- `OpenAISyntheticEcommerceDataSource`: model-backed synthetic responses through the same data source interface.
- `SyntheticEcommerceToolRegistry`: an AptKit `ToolRegistry` adapter that lets agents call the provider as tools.
- `syntheticEcommerceToolDefinitions`: the provider tool contract.

## Tools

- `get_project_overview`: returns workspace metadata, event names, data horizon, and scenario highlights.
- `get_metric_timeseries`: returns metric movement, comparison windows, related segments, and points.
- `get_anomaly_context`: returns anomaly summary, related segments, likely drivers, and sample records.

## Architecture

The important boundary is source vs tool vs agent:

- Fixture source: fake data, no model, deterministic output.
- OpenAI source: real model generates synthetic data, still no real customer data.
- Tool registry: exposes either source through the same tool names.
- Agents: consume tools without knowing whether the data came from fixture JSON, OpenAI synthetic generation, or a future production data adapter.

This lets AptKit test agent behavior with controlled data now while keeping the door open for Blooming Insights to remove the Olist MCP server later.

## Studio

Studio now has a Synthetic Data Provider workspace. It can run fixture-backed provider tools in the browser and OpenAI-backed provider tools through the Studio server endpoint. It displays:

- provider metadata
- tool definitions
- selected input schema
- returned JSON payload
- fixture vs OpenAI source boundary

The live OpenAI mode calls `/api/synthetic/tool` from Studio. That endpoint constructs `OpenAISyntheticEcommerceDataSource` server-side using `OPENAI_API_KEY`, runs the selected tool through `SyntheticEcommerceToolRegistry`, and returns only the generated provider payload and run metadata to the browser.
