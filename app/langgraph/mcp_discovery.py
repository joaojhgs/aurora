"""
MCP Server Discovery Service

This module provides automatic discovery of MCP servers using various methods:
- Configuration file discovery (Claude Desktop style)
- npm/pip package discovery
- Process discovery (running servers)
- Network discovery (HTTP servers)
"""

import json
import os
import socket
import subprocess
from dataclasses import dataclass
from typing import Any, Optional

import psutil

from app.helpers.aurora_logger import log_debug, log_info


@dataclass
class DiscoveredServer:
    """Represents a discovered MCP server"""

    name: str
    transport: str  # stdio, http, sse, websocket
    command: Optional[str] = None
    args: Optional[list[str]] = None
    url: Optional[str] = None
    env: Optional[dict[str, str]] = None
    source: str = "unknown"  # discovery method
    description: Optional[str] = None
    installed: bool = True


class MCPServerDiscovery:
    """Service for discovering MCP servers"""

    def __init__(self):
        self.discovered_servers: dict[str, DiscoveredServer] = {}

    async def discover_all_servers(self) -> dict[str, DiscoveredServer]:
        """Discover MCP servers using all available methods"""
        log_info("Starting MCP server discovery...")

        # Clear previous discoveries
        self.discovered_servers.clear()

        # Run discovery methods
        await self._discover_from_config_files()
        await self._discover_npm_packages()
        await self._discover_pip_packages()
        await self._discover_running_processes()
        await self._discover_network_servers()

        log_info(f"Discovery complete. Found {len(self.discovered_servers)} servers")
        return self.discovered_servers.copy()

    async def _discover_from_config_files(self):
        """Discover servers from Claude Desktop and other config files"""
        log_debug("Discovering servers from configuration files...")

        config_paths = [
            # Claude Desktop configs
            os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json"),  # macOS
            os.path.expanduser("~/.config/claude/claude_desktop_config.json"),  # Linux
            os.path.join(os.environ.get("APPDATA", ""), "Claude", "claude_desktop_config.json"),  # Windows
            # Other potential MCP config locations
            os.path.expanduser("~/.mcp/servers.json"),
            os.path.expanduser("~/.config/mcp/servers.json"),
            "./mcp_servers.json",
        ]

        for config_path in config_paths:
            if os.path.exists(config_path):
                try:
                    with open(config_path) as f:
                        config = json.load(f)

                    # Handle Claude Desktop format
                    if "mcpServers" in config:
                        for name, server_config in config["mcpServers"].items():
                            await self._add_discovered_server(
                                name=name,
                                transport="stdio",  # Claude Desktop uses stdio
                                command=server_config.get("command"),
                                args=server_config.get("args", []),
                                env=server_config.get("env"),
                                source=f"config_file:{config_path}",
                                description="From Claude Desktop config",
                            )

                    # Handle generic MCP server format
                    elif "servers" in config:
                        for name, server_config in config["servers"].items():
                            await self._add_discovered_server(
                                name=name,
                                transport=server_config.get("transport", "stdio"),
                                command=server_config.get("command"),
                                args=server_config.get("args", []),
                                url=server_config.get("url"),
                                env=server_config.get("env"),
                                source=f"config_file:{config_path}",
                                description="From MCP config file",
                            )

                    log_debug(f"Processed config file: {config_path}")

                except Exception as e:
                    log_debug(f"Could not read config file {config_path}: {e}")

    async def _discover_npm_packages(self):
        """Discover MCP servers installed as npm packages"""
        log_debug("Discovering npm MCP packages...")

        try:
            # Check if npm is available
            result = subprocess.run(["npm", "--version"], capture_output=True, text=True, timeout=5)
            if result.returncode != 0:
                log_debug("npm not available, skipping npm package discovery")
                return

            # List global npm packages
            result = subprocess.run(["npm", "list", "-g", "--depth=0", "--json"], capture_output=True, text=True, timeout=30)

            if result.returncode == 0:
                npm_data = json.loads(result.stdout)
                dependencies = npm_data.get("dependencies", {})

                for package_name, package_info in dependencies.items():
                    if self._is_mcp_package(package_name):
                        await self._add_discovered_server(
                            name=package_name.replace("@modelcontextprotocol/server-", "").replace("mcp-server-", ""),
                            transport="stdio",
                            command="npx",
                            args=["-y", package_name],
                            source="npm_global",
                            description=f"npm package: {package_name}",
                        )

            # Check local packages too
            if os.path.exists("package.json"):
                result = subprocess.run(["npm", "list", "--depth=0", "--json"], capture_output=True, text=True, timeout=30)

                if result.returncode == 0:
                    npm_data = json.loads(result.stdout)
                    dependencies = npm_data.get("dependencies", {})

                    for package_name, package_info in dependencies.items():
                        if self._is_mcp_package(package_name):
                            await self._add_discovered_server(
                                name=package_name.replace("@modelcontextprotocol/server-", "").replace("mcp-server-", ""),
                                transport="stdio",
                                command="npx",
                                args=[package_name],
                                source="npm_local",
                                description=f"Local npm package: {package_name}",
                            )

        except Exception as e:
            log_debug(f"Error discovering npm packages: {e}")

    async def _discover_pip_packages(self):
        """Discover MCP servers installed as pip packages"""
        log_debug("Discovering pip MCP packages...")

        try:
            # List installed pip packages
            result = subprocess.run(["pip", "list", "--format=json"], capture_output=True, text=True, timeout=30)

            if result.returncode == 0:
                packages = json.loads(result.stdout)

                for package in packages:
                    package_name = package["name"]
                    if self._is_mcp_package(package_name):
                        server_name = package_name.replace("mcp-server-", "").replace("mcp_server_", "")

                        await self._add_discovered_server(
                            name=server_name,
                            transport="stdio",
                            command="python",
                            args=["-m", package_name.replace("-", "_")],
                            source="pip",
                            description=f"pip package: {package_name}",
                        )

        except Exception as e:
            log_debug(f"Error discovering pip packages: {e}")

    async def _discover_running_processes(self):
        """Discover running MCP servers by scanning processes"""
        log_debug("Discovering running MCP processes...")

        try:
            for proc in psutil.process_iter(["pid", "name", "cmdline"]):
                try:
                    cmdline = proc.info["cmdline"]
                    if cmdline and self._is_mcp_process(cmdline):
                        # Extract server info from command line
                        server_name = self._extract_server_name_from_cmdline(cmdline)
                        if server_name:
                            await self._add_discovered_server(
                                name=server_name,
                                transport="stdio",  # Most likely stdio
                                command=cmdline[0] if cmdline else None,
                                args=cmdline[1:] if len(cmdline) > 1 else [],
                                source="running_process",
                                description=f"Running process (PID: {proc.info['pid']})",
                            )
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue

        except Exception as e:
            log_debug(f"Error discovering running processes: {e}")

    async def _discover_network_servers(self):
        """Discover HTTP/WebSocket MCP servers on localhost"""
        log_debug("Discovering network MCP servers...")

        # Common ports for MCP servers
        common_ports = [3000, 3001, 8000, 8001, 8080, 8081, 9000, 9001]

        for port in common_ports:
            try:
                # Test HTTP connection
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(1)
                result = sock.connect_ex(("localhost", port))
                sock.close()

                if result == 0:
                    # Port is open, test if it's an MCP server
                    if await self._test_mcp_http_server(port):
                        await self._add_discovered_server(
                            name=f"http_server_{port}",
                            transport="http",
                            url=f"http://localhost:{port}",
                            source="network_scan",
                            description=f"HTTP server on port {port}",
                        )

            except Exception as e:
                log_debug(f"Error testing port {port}: {e}")

    async def _add_discovered_server(self, name: str, transport: str, **kwargs):
        """Add a discovered server to the collection"""
        server = DiscoveredServer(name=name, transport=transport, **kwargs)

        # Avoid duplicates by using a composite key
        key = f"{name}_{transport}_{kwargs.get('source', 'unknown')}"
        if key not in self.discovered_servers:
            self.discovered_servers[key] = server
            log_debug(f"Discovered server: {name} ({transport}) from {kwargs.get('source', 'unknown')}")

    def _is_mcp_package(self, package_name: str) -> bool:
        """Check if a package name indicates an MCP server"""
        mcp_indicators = ["@modelcontextprotocol/server-", "mcp-server-", "mcp_server_", "mcp-", "-mcp"]
        return any(indicator in package_name.lower() for indicator in mcp_indicators)

    def _is_mcp_process(self, cmdline: list[str]) -> bool:
        """Check if a command line indicates an MCP server process"""
        if not cmdline:
            return False

        cmdline_str = " ".join(cmdline).lower()
        mcp_indicators = [
            "mcp-server",
            "mcp_server",
            "mcp-remote",
            "@modelcontextprotocol",
            "server-filesystem",
            "server-memory",
            "server-fetch",
            "mcp-",
            "-mcp",
        ]
        isMcpProcess = any(indicator in cmdline_str for indicator in mcp_indicators)
        if isMcpProcess:
            print(f"{isMcpProcess}: {cmdline_str}")
        return isMcpProcess

    def _extract_server_name_from_cmdline(self, cmdline: list[str]) -> Optional[str]:
        """Extract server name from command line"""

        # Look for package names
        for arg in cmdline:
            if "@modelcontextprotocol/server-" in arg:
                return arg.split("server-")[-1].split(" ")[0]
            elif "mcp-server-" in arg:
                return arg.split("mcp-server-")[-1].split(" ")[0]
            elif "mcp_server_" in arg:
                return arg.split("mcp_server_")[-1].split(" ")[0]
            elif "mcp-" in arg:
                return arg.split("mcp-")[-1].split(" ")[0]
            elif "-mcp" in arg:
                return arg.split("-mcp")[-1].split(" ")[0]

        return None

    async def _test_mcp_http_server(self, port: int) -> bool:
        """Test if an HTTP server on a port is an MCP server"""
        try:
            import aiohttp

            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as session:
                # Try common MCP endpoints
                test_urls = [
                    f"http://localhost:{port}/mcp",
                    f"http://localhost:{port}/",
                ]

                for url in test_urls:
                    try:
                        async with session.get(url) as response:
                            # Look for MCP-specific headers or content
                            content = await response.text()
                            if "mcp" in content.lower() or "model context protocol" in content.lower():
                                return True
                    except BaseException:
                        continue

        except ImportError:
            # aiohttp not available, skip HTTP testing
            pass
        except Exception as e:
            log_debug(f"Error testing HTTP server on port {port}: {e}")

        return False

    def get_servers_by_source(self, source: str) -> list[DiscoveredServer]:
        """Get discovered servers by discovery source"""
        return [server for server in self.discovered_servers.values() if server.source.startswith(source)]

    def get_server_configs_for_aurora(self) -> dict[str, dict[str, Any]]:
        """Convert discovered servers to Aurora MCP configuration format"""
        configs = {}

        for server in self.discovered_servers.values():
            config = {"transport": server.transport, "enabled": True}

            if server.command:
                config["command"] = server.command
            if server.args:
                config["args"] = server.args
            if server.url:
                config["url"] = server.url
            if server.env:
                config["env"] = server.env

            # Add metadata
            config["_discovery_source"] = server.source
            if server.description:
                config["_description"] = server.description

            configs[server.name] = config

        return configs


# Global discovery service instance
mcp_discovery = MCPServerDiscovery()


async def discover_mcp_servers() -> dict[str, DiscoveredServer]:
    """Convenience function to discover all MCP servers"""
    return await mcp_discovery.discover_all_servers()


def get_discovered_servers() -> dict[str, DiscoveredServer]:
    """Get currently discovered servers"""
    return mcp_discovery.discovered_servers.copy()
