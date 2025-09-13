# MCP (Model Context Protocol) Integration for Aurora

Aurora now supports the Model Context Protocol (MCP), allowing you to integrate external tools and services seamlessly into your AI assistant.

## What is MCP?

The Model Context Protocol (MCP) is an open standard that enables AI assistants to securely connect to external data sources and tools. It provides a standardized way to extend AI capabilities with custom functionality while maintaining security and privacy.

## Features

- **Multiple Transport Types**: Support for stdio (local processes) and HTTP (remote services)
- **Async Integration**: Full async/await support for non-blocking tool execution
- **Dynamic Loading**: Tools are loaded dynamically and integrated into Aurora's RAG-based tool selection
- **Authentication**: Support for headers-based authentication for HTTP servers
- **Error Handling**: Robust error handling and logging for MCP operations

## Configuration

Add MCP servers to your `config.json` file:

```json
{
  "mcp": {
    "enabled": true,
    "servers": {
      "math": {
        "command": "python",
        "args": ["/absolute/path/to/aurora/examples/mcp_servers/math_server.py"],
        "transport": "stdio",
        "enabled": true
      },
      "weather": {
        "url": "http://localhost:8000/mcp/",
        "transport": "streamable_http",
        "headers": {
          "Authorization": "Bearer your_api_token_here",
          "X-Custom-Header": "custom-value"
        },
        "enabled": true
      }
    }
  }
}
```

## Transport Types

### stdio
- **Use case**: Local servers running as subprocesses
- **Configuration**: Requires `command` and optionally `args`
- **Security**: Runs with same permissions as Aurora
- **Example**: Local file operations, math calculations, system commands

### streamable_http
- **Use case**: Remote HTTP servers
- **Configuration**: Requires `url`, optionally `headers` for authentication
- **Security**: Network-based, supports authentication headers
- **Example**: Web APIs, cloud services, remote databases

### sse (Server-Sent Events)
- **Use case**: Real-time streaming data from HTTP servers
- **Configuration**: Similar to streamable_http but for streaming
- **Example**: Live data feeds, real-time notifications

## Creating Custom MCP Servers

1. **Install FastMCP**:
   ```bash
   pip install fastmcp
   ```

2. **Create your server**:
   ```python
   from mcp.server.fastmcp import FastMCP

   mcp = FastMCP("Your Server Name")

   @mcp.tool()
   def your_function(param: str) -> str:
       """Description of what your function does."""
       return f"Result: {param}"

   if __name__ == "__main__":
       mcp.run(transport="stdio")  # or "streamable_http"
   ```

3. **Add to Aurora configuration**
4. **Restart Aurora**

## Security Considerations

- **stdio servers**: Execute with Aurora's permissions
- **HTTP servers**: Use HTTPS and authentication for production
- **Input validation**: Always validate tool inputs
- **Rate limiting**: Consider implementing rate limits for HTTP servers

## Integration Details

Aurora's MCP integration:

1. **Initialization**: MCP clients are initialized at Aurora startup
2. **Tool Loading**: Tools are loaded asynchronously and added to the tool database
3. **RAG Integration**: MCP tools participate in semantic tool selection
4. **Execution**: Tools are executed within Aurora's LangGraph workflow
5. **Error Handling**: Robust error handling with detailed logging

## Troubleshooting

### Common Issues

1. **Tools not loading**: Check Aurora logs for MCP initialization errors
2. **Connection failures**: Verify server URLs and transport configurations
3. **Authentication errors**: Ensure headers are correctly configured
4. **Tool execution errors**: Check individual server logs

### Debug Steps

1. Enable debug logging in Aurora
2. Test MCP servers independently
3. Verify configuration syntax
4. Check network connectivity for HTTP servers

## Advanced Features

### Multiple Servers
Aurora can connect to multiple MCP servers simultaneously, combining their tools into a unified interface.

### Resource Management
Future versions will support MCP resources (files, documents, data) in addition to tools.

### Sampling
Some MCP servers support sampling capabilities for content generation.

## Dependencies

Aurora's MCP integration uses:
- `langchain-mcp-adapters>=0.1.8`: LangChain integration layer
- `fastmcp`: For creating MCP servers (optional, for custom servers)

## Contributing

To contribute to Aurora's MCP integration:
1. Create example servers demonstrating new capabilities
2. Improve error handling and logging
3. Add support for additional transport types
4. Enhance documentation and examples
