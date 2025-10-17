from langchain_community.agent_toolkits.jira.toolkit import JiraToolkit
from langchain_community.utilities.jira import JiraAPIWrapper

jira = JiraAPIWrapper()

toolkit = JiraToolkit.from_jira_api_wrapper(jira)

jira_tools = toolkit.get_tools()
