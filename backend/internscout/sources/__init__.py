from .github_lists import fetch_github_lists
from .greenhouse import fetch_greenhouse, fetch_greenhouse_board
from .lever import fetch_lever, fetch_lever_board
from .ashby import fetch_ashby_board
from .workday import fetch_workday_board
from .smartrecruiters import fetch_smartrecruiters_board
from .workable import fetch_workable_board
from .recruitee import fetch_recruitee_board
from .bamboohr import fetch_bamboohr_board
from .rippling import fetch_rippling_board
from .oracle import fetch_oracle_board
from .taleo import fetch_taleo_board
from .adp import fetch_adp_board
from .jobvite import fetch_jobvite_board
from .icims import fetch_icims_board
from .successfactors import fetch_successfactors_board
from .eightfold import fetch_eightfold_board
from .jazzhr import fetch_jazzhr_board
from .google_jobs import fetch_google_jobs
from .usajobs import fetch_usajobs
from .nyc_jobs import fetch_nyc_jobs

# one-board fetchers: fn(httpx.Client, {name, ats_token, is_quant_target}) -> raw items
BOARD_FETCHERS = {
    "greenhouse": fetch_greenhouse_board,
    "lever": fetch_lever_board,
    "ashby": fetch_ashby_board,
    "workday": fetch_workday_board,
    "smartrecruiters": fetch_smartrecruiters_board,
    "workable": fetch_workable_board,
    "recruitee": fetch_recruitee_board,
    "bamboohr": fetch_bamboohr_board,
    "rippling": fetch_rippling_board,
    "oracle": fetch_oracle_board,
    "taleo": fetch_taleo_board,
    "adp": fetch_adp_board,
    "jobvite": fetch_jobvite_board,
    "icims": fetch_icims_board,
    "successfactors": fetch_successfactors_board,
    "eightfold": fetch_eightfold_board,
    "jazzhr": fetch_jazzhr_board,
}
__all__ = ["fetch_github_lists", "fetch_greenhouse", "fetch_lever", "fetch_google_jobs", "fetch_usajobs",
           "fetch_nyc_jobs", "BOARD_FETCHERS"]
