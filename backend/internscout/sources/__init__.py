from .github_lists import fetch_github_lists
from .greenhouse import fetch_greenhouse, fetch_greenhouse_board
from .lever import fetch_lever, fetch_lever_board
from .ashby import fetch_ashby_board
from .workday import fetch_workday_board
from .smartrecruiters import fetch_smartrecruiters_board
from .google_jobs import fetch_google_jobs

# one-board fetchers: fn(httpx.Client, {name, ats_token, is_quant_target}) -> raw items
BOARD_FETCHERS = {
    "greenhouse": fetch_greenhouse_board,
    "lever": fetch_lever_board,
    "ashby": fetch_ashby_board,
    "workday": fetch_workday_board,
    "smartrecruiters": fetch_smartrecruiters_board,
}
__all__ = ["fetch_github_lists", "fetch_greenhouse", "fetch_lever", "fetch_google_jobs", "BOARD_FETCHERS"]
