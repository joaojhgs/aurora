from langchain_community.agent_toolkits import SlackToolkit

toolkit = SlackToolkit()
slack_tools = toolkit.get_tools()