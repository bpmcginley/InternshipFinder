"""Which listings are near which of the 50 largest US metros, and which belong to which of the ten
largest degree-field groups (2026-10-18). seo_pages builds "<field> internships near <city>" from these.

The metros are us_top50_metros.json (Census Vintage 2025 MSA population) and the field groups
top_degree_fields.json (NCES Digest 2023 Table 322.10, 2021-22 bachelor's degrees).

How a listing is matched to a metro (what the export supports):
  * The export's regions carry a location string, a state code and a kind (us, new_england, nyc_metro,
    remote, canada). They carry no coordinates, and geo.GAZETTEER only knows the Northeast, so a radius
    around each anchor city is not possible for most of the country.
  * So each metro is a list of towns per state: the metro's principal cities and the other cities and
    towns of the counties that make up its Census metropolitan statistical area (MSA), as the
    listings name them. A region counts for a metro only when its own state code is one of the metro's
    states AND its location names one of that state's towns. "Portland, ME" is never Portland, OR;
    "Birmingham, MI" counts for Detroit and never for Birmingham, AL.
  * New York is the one metro the export does measure: region.py gives a location within 50 miles of
    Midtown Manhattan (by coordinates) the kind "nyc_metro". Connecticut locations instead keep
    "new_england", so their known town coordinates are checked against the same radius here.
    New York uses that radius, plus the five boroughs by name. Washington, DC counts any location
    in the District itself.
  * Never counted as local: a location that only names a state or the country ("Colorado", "United
    States"), any location that says remote, work from home or virtual ("Remote, TX" too, since it is
    remote within a state), and anything in Canada. US-remote roles are shown in a section of their own.
  * A town whose postal name spans two metros' counties is listed under both (Laurel, MD: the city is
    in Prince George's County, Washington's metro, but the Laurel postal area takes in Howard County,
    Baltimore's). It is the only such case.

The lists were written from the MSA county definitions and checked against the town names in the
2026-10-18 export (docs/data). A town missing from a list makes the page undercount, never overcount.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .config import REGION
from .geo import GAZETTEER, REMOTE_RE, STATE_NAMES, haversine_miles

_HERE = Path(__file__).parent
METROS = tuple(json.loads((_HERE / "us_top50_metros.json").read_text(encoding="utf-8"))["metros"])
FIELDS = tuple(json.loads((_HERE / "top_degree_fields.json").read_text(encoding="utf-8"))["fields"])

# ---------------------------------------------------------------- the ten field groups
# NCES broad field -> InternScout field tags (classify.RULES). A listing is in the group when it carries
# any of these tags. top_degree_fields.json carries the same lists (tests/test_near_pages.py checks the
# two agree and that every tag is one classify.py can give).
#   Business: every business function InternScout tags, hospitality included (NCES counts hospitality
#     management under Business, CIP 52.09). Quantitative finance ("quant") is left out: those roles
#     mostly want math and CS majors.
#   Health Professions: health, nursing, public health and clinical research.
#   Social Sciences and History: social science, economics, government (political science and public
#     policy), and museums (the nearest tag to history; there is no history tag). Thin.
#   Biological and Biomedical Sciences: biology, and biomedical, which classify.py gives to biomedical
#     research and biomedical engineering alike, so it is in Engineering too.
#   Psychology: one tag, psychology (also behavioral and mental health roles).
#   Engineering: the general tag and every engineering discipline; environmental is environmental
#     science and engineering together.
#   Computer and Information Sciences: software, data, machine learning and AI, cybersecurity.
#   Visual and Performing Arts: arts, design (visual, UX and graphic design), theater, music, film. Thin.
#   Education: one tag, education (teaching, tutoring, curriculum, instructional design). Thin.
#   Communication and Journalism: communications, journalism, media, publishing.
FIELD_TAGS = {
    "business": ("business", "finance", "accounting", "consulting", "marketing", "sales", "hr", "operations",
                 "supply_chain", "entrepreneurship", "pm", "real_estate", "insurance", "retail", "hospitality"),
    "health-professions": ("health", "nursing", "public_health", "clinical_research"),
    "social-sciences-and-history": ("social_science", "economics", "government", "museums"),
    "biological-and-biomedical-sciences": ("biology", "biomedical"),
    "psychology": ("psychology",),
    "engineering": ("engineering", "mechanical", "electrical", "civil", "chemical", "industrial", "aerospace",
                    "hardware", "materials", "environmental", "biomedical"),
    "computer-and-information-sciences": ("swe", "data", "ml", "security"),
    "visual-and-performing-arts": ("arts", "design", "theater", "music", "film"),
    "education": ("education",),
    "communication-and-journalism": ("communications", "journalism", "media", "publishing"),
}
# The shorter name a title falls back to when the full one will not fit (seo_pages.fit_head).
FIELD_SHORT = {
    "health-professions": "Health",
    "social-sciences-and-history": "Social Science",
    "biological-and-biomedical-sciences": "Biology",
    "computer-and-information-sciences": "Computer Science",
    "visual-and-performing-arts": "Arts",
    "communication-and-journalism": "Communications",
}


def field_of(slug: str) -> dict:
    return next(f for f in FIELDS if f["slug"] == slug)


# ---------------------------------------------------------------- the 50 metros
# CBSA -> {state code: "town|town|..."}, lower case, "st" for Saint/St., "fort" for Ft., "mount" for Mt.
# (place_tokens reads a location the same way).
_TOWNS = {
    "35620": {  # New York: kind nyc_metro (50 miles of Midtown), and the boroughs by name
        "NY": "new york city|nyc|manhattan|brooklyn|queens|bronx|the bronx|staten island|long island city|"
              "astoria|flushing|jamaica|harlem",
    },
    "31080": {  # Los Angeles: Los Angeles and Orange counties
        "CA": "los angeles|la|long beach|anaheim|santa ana|irvine|glendale|pasadena|torrance|el segundo|santa monica|"
              "culver city|burbank|inglewood|hawthorne|manhattan beach|redondo beach|hermosa beach|carson|gardena|"
              "compton|downey|norwalk|whittier|pomona|west covina|el monte|south el monte|alhambra|rosemead|"
              "monterey park|arcadia|monrovia|azusa|covina|diamond bar|walnut|city of industry|industry|cerritos|"
              "lakewood|bellflower|paramount|lynwood|south gate|vernon|commerce|montebello|pico rivera|la mirada|"
              "santa fe springs|calabasas|agoura hills|westlake village|malibu|beverly hills|west hollywood|"
              "playa vista|playa del rey|venice|marina del rey|hollywood|north hollywood|van nuys|northridge|"
              "chatsworth|woodland hills|canoga park|sherman oaks|encino|studio city|sun valley|sylmar|san fernando|"
              "santa clarita|valencia|lancaster|palmdale|san pedro|wilmington|harbor city|lawndale|signal hill|"
              "seal beach|huntington beach|costa mesa|newport beach|fullerton|orange|garden grove|tustin|"
              "fountain valley|westminster|buena park|cypress|los alamitos|la palma|brea|yorba linda|placentia|"
              "mission viejo|lake forest|laguna hills|laguna niguel|laguna beach|aliso viejo|rancho santa margarita|"
              "san clemente|san juan capistrano|dana point|foothill ranch|claremont|la verne|san dimas|glendora|"
              "duarte|south pasadena|san gabriel|temple city|la canada flintridge|sierra madre|baldwin park|"
              "hacienda heights|rowland heights|la puente|el segundo|westchester|century city|sawtelle|",
    },
    "16980": {  # Chicago: Cook, DuPage, Kane, Kendall, Lake, McHenry, Will, Grundy, DeKalb (IL); Lake, Porter, Newton, Jasper (IN)
        "IL": "chicago|evanston|skokie|niles|glenview|northbrook|northfield|deerfield|lake forest|lake bluff|"
              "highland park|rosemont|des plaines|park ridge|schaumburg|rolling meadows|hoffman estates|palatine|"
              "arlington heights|elk grove village|itasca|wood dale|bensenville|franklin park|naperville|lisle|"
              "downers grove|oak brook|oakbrook terrace|westchester|westmont|lombard|wheaton|glen ellyn|carol stream|"
              "addison|elmhurst|warrenville|aurora|north aurora|batavia|geneva|st charles|elgin|west dundee|"
              "east dundee|carpentersville|crystal lake|mchenry|cary|woodstock|algonquin|huntley|lake zurich|"
              "buffalo grove|vernon hills|libertyville|mundelein|lincolnshire|riverwoods|waukegan|north chicago|"
              "abbott park|gurnee|zion|joliet|bolingbrook|romeoville|lemont|plainfield|oswego|yorkville|morris|"
              "minooka|channahon|frankfort|mokena|tinley park|orland park|oak lawn|alsip|bedford park|summit|cicero|"
              "berwyn|oak park|forest park|maywood|melrose park|hillside|broadview|harvey|chicago heights|homewood|"
              "calumet city|lansing|dekalb|sycamore|braceville|hanover park|bartlett|streamwood|wilmette|winnetka|"
              "glencoe|morton grove|lincolnwood|harwood heights|burr ridge|willowbrook|darien|woodridge|hinsdale|"
              "la grange|countryside|bridgeview|hodgkins|mccook|mount prospect|prospect heights|wheeling|"
              "great lakes|hines|west chicago|roselle|bloomingdale|glendale heights|villa park|oakbrook|"
              "university park|matteson|crete|lockport|new lenox|manhattan|wilmington|sugar grove|montgomery|"
              "south elgin|st charles|barrington|inverness|deer park|kildeer|hawthorn woods|wauconda|round lake|"
              "antioch|lake villa|fox lake|grayslake|park city|beach park|mettawa|bannockburn|elburn|hampshire|"
              "marengo|harvard|genoa|sandwich|plano|coal city|diamond|gardner|braidwood|evergreen park|"
              "blue island|chicago ridge|worth|palos hills|palos heights|hickory hills|justice|lansing|dolton|"
              "riverdale|south holland|thornton|glenwood|lynwood|sauk village|steger|park forest|richton park|"
              "olympia fields|flossmoor|hazel crest|country club hills|markham|midlothian|oak forest|posen|"
              "robbins|crestwood|stickney|lyons|riverside|north riverside|brookfield|western springs|"
              "la grange park|westchester|bellwood|stone park|northlake|schiller park|norridge|river grove|"
              "elmwood park|river forest|golf|kenilworth|fort sheridan",
        "IN": "hammond|gary|east chicago|whiting|munster|highland|merrillville|crown point|schererville|hobart|"
              "portage|valparaiso|chesterton|indiana harbor|burns harbor|dyer|st john|cedar lake|lowell|"
              "rensselaer|griffith|lake station|winfield|kouts|wheatfield|demotte|kentland|morocco",
    },
    "19100": {  # Dallas-Fort Worth
        "TX": "dallas|fort worth|arlington|plano|irving|las colinas|richardson|frisco|mckinney|allen|garland|"
              "mesquite|carrollton|addison|coppell|grapevine|southlake|westlake|keller|lewisville|flower mound|"
              "denton|the colony|little elm|prosper|celina|wylie|rockwall|rowlett|sachse|grand prairie|mansfield|"
              "cedar hill|desoto|duncanville|lancaster|farmers branch|euless|bedford|hurst|colleyville|"
              "north richland hills|haltom city|richland hills|haslet|roanoke|trophy club|alliance|saginaw|"
              "benbrook|burleson|weatherford|cleburne|waxahachie|midlothian|ennis|forney|terrell|kaufman|"
              "greenville|university park|highland park|red oak|crowley|azle|aledo|granbury|decatur|dfw|"
              "dfw airport|murphy|fairview|lucas|parker|princeton|anna|melissa|sunnyvale|seagoville|balch springs|"
              "hutchins|wilmer|white settlement|watauga|lake worth|river oaks|everman|kennedale|joshua|"
              "lake dallas|corinth|highland village|argyle|justin|sanger|aubrey|krum|northlake|royse city|"
              "heath|fate|glenn heights|ovilla|palmer|crandall|mabank|mineral wells|springtown",
    },
    "26420": {  # Houston
        "TX": "houston|the woodlands|woodlands|spring|sugar land|katy|pasadena|pearland|baytown|deer park|la porte|"
              "texas city|league city|friendswood|webster|clear lake|seabrook|kemah|galveston|kingwood|humble|"
              "atascocita|cypress|tomball|conroe|magnolia|montgomery|missouri city|stafford|richmond|rosenberg|"
              "fulshear|bellaire|west university place|channelview|crosby|freeport|lake jackson|angleton|alvin|"
              "clute|sweeny|dickinson|la marque|hitchcock|santa fe|waller|hempstead|dayton|liberty|cleveland|"
              "mont belvieu|jersey village|south houston|nassau bay|el lago|taylor lake village|shenandoah|"
              "porter|new caney|splendora|willis|manvel|brookshire|sealy|needville|east bernard|wharton|"
              "old ocean|brazoria|bacliff|san leon|la porte|highlands|galena park|jacinto city|hockley|"
              "prairie view|ellington|johnson space center||",
    },
    "12060": {  # Atlanta
        "GA": "atlanta|atl|sandy springs|roswell|alpharetta|milton|johns creek|duluth|suwanee|buford|lawrenceville|"
              "norcross|peachtree corners|dunwoody|brookhaven|chamblee|doraville|tucker|decatur|stone mountain|"
              "lithonia|conyers|covington|mcdonough|stockbridge|jonesboro|morrow|forest park|east point|"
              "college park|hapeville|union city|fairburn|palmetto|peachtree city|fayetteville|newnan|douglasville|"
              "austell|mableton|smyrna|marietta|kennesaw|acworth|woodstock|canton|cartersville|cumming|dallas|"
              "powder springs|snellville|loganville|monroe|winder|braselton|dobbins|dobbins arb|dobbins afb|hampton|"
              "lilburn|grayson|dacula|sugar hill|holly springs|ball ground|villa rica|carrollton|tyrone|"
              "senoia|griffin|locust grove|jackson|social circle|madison|lovejoy|riverdale|ellenwood|redan|"
              "clarkston|avondale estates|scottdale|vinings|lithia springs|hiram|dallas|rockmart|adairsville|"
              "|emerson|euharlee|statham|bethlehem|auburn|bogart|oxford|porterdale|mansfield",
    },
    "47900": {  # Washington, DC: the District, and its Virginia, Maryland and West Virginia counties
        "VA": "arlington|arlington county|alexandria|fairfax|falls church|mclean|tysons|tysons corner|vienna|reston|herndon|"
              "chantilly|centreville|sterling|dulles|ashburn|leesburg|manassas|manassas park|woodbridge|"
              "springfield|annandale|burke|lorton|fort belvoir|quantico|dumfries|stafford|fredericksburg|"
              "warrenton|gainesville|haymarket|bristow|purcellville|crystal city|pentagon|the pentagon|rosslyn|"
              "ballston|merrifield|oakton|great falls|clifton|fairfax station|lake ridge|triangle|"
              "spotsylvania|culpeper|front royal|middleburg|south riding|aldie|lansdowne|broadlands|"
              "dunn loring|west springfield|kingstowne|franconia|mount vernon|nokesville|catlett|"
              "king george|dahlgren|joint base myer-henderson hall|fort myer",
        "MD": "bethesda|rockville|gaithersburg|germantown|silver spring|college park|greenbelt|laurel|bowie|"
              "upper marlboro|largo|hyattsville|landover|lanham|beltsville|white oak|chevy chase|potomac|"
              "north bethesda|kensington|wheaton|takoma park|clarksburg|frederick|urbana|andrews afb|"
              "joint base andrews|suitland|camp springs|oxon hill|national harbor|fort washington|waldorf|"
              "la plata|goddard|goddard sfc|goddard space flight center|adelphi|riverdale|capitol heights|"
              "district heights|temple hills|clinton|brandywine|accokeek|glenn dale|mitchellville|"
              "cheverly|bladensburg|mount rainier|new carrollton|damascus|olney|boyds|poolesville|"
              "montgomery village|derwood|burtonsville|calverton|indian head|white plains|prince frederick|"
              "lusby|solomons|huntingtown|chesapeake beach|brunswick|middletown|walkersville|thurmont|"
              "myersville||ijamsville|point of rocks",
        "WV": "charles town|harpers ferry|ranson|shepherdstown|kearneysville",
    },
    "33100": {  # Miami: Miami-Dade, Broward, Palm Beach
        "FL": "miami|miami beach|miami gardens|miami lakes|hialeah|doral|coral gables|kendall|homestead|aventura|"
              "north miami|north miami beach|sunny isles beach|key biscayne|medley|sweetwater|florida city|"
              "cutler bay|palmetto bay|pinecrest|fort lauderdale|hollywood|pembroke pines|miramar|plantation|"
              "sunrise|davie|weston|coral springs|pompano beach|deerfield beach|lauderdale lakes|lauderhill|"
              "tamarac|margate|coconut creek|oakland park|dania beach|hallandale beach|cooper city|parkland|"
              "west palm beach|palm beach|palm beach gardens|boca raton|delray beach|boynton beach|lake worth|"
              "lake worth beach|jupiter|wellington|royal palm beach|riviera beach|greenacres|belle glade|"
              "juno beach|tequesta|lantana|opa-locka|opa locka|miami springs|virginia gardens|south miami|"
              "west miami|el portal|biscayne park|surfside|bal harbour|north bay village|wilton manors|"
              "lighthouse point|hillsboro beach|lauderdale by the sea|southwest ranches|pembroke park|"
              "west park|north lauderdale|highland beach|ocean ridge|gulf stream|north palm beach|"
              "lake park|palm springs|loxahatchee|pahokee|south bay",
    },
    "37980": {  # Philadelphia: Bucks, Chester, Delaware, Montgomery, Philadelphia (PA); Burlington, Camden, Gloucester, Salem (NJ); New Castle (DE); Cecil (MD)
        "PA": "philadelphia|king of prussia|conshohocken|west conshohocken|malvern|wayne|radnor|bala cynwyd|"
              "ardmore|haverford|bryn mawr|villanova|exton|fort washington|horsham|blue bell|collegeville|"
              "spring house|west point|plymouth meeting|ridley park|west chester|newtown square|berwyn|devon|"
              "paoli|frazer|chesterbrook|tredyffrin|norristown|lansdale|north wales|ambler|willow grove|"
              "jenkintown|abington|elkins park|glenside|hatboro|warminster|doylestown|newtown|langhorne|bensalem|"
              "levittown|bristol|yardley|morrisville|chalfont|quakertown|souderton|telford|harleysville|"
              "kulpsville|pottstown|phoenixville|royersford|upper providence|audubon|oaks|eagleville|trappe|"
              "limerick|coatesville|downingtown|kennett square|oxford|media|chester|eddystone|glenolden|folcroft|"
              "essington|sharon hill|darby|upper darby|havertown|springfield|swarthmore|broomall|marcus hook|"
              "aston|glen mills|concordville|chadds ford|wynnewood|gladwyne|lafayette hill|flourtown|oreland|"
              "huntingdon valley|feasterville|trevose|southampton|ivyland|new hope|fairless hills|east norriton|"
              "montgomeryville|colmar|skippack|schwenksville|gilbertsville|lionville|chester springs|"
              "avondale|west grove|parkesburg|honey brook|elverson|kimberton|spring city|perkasie|sellersville|"
              "dublin|furlong|jamison|warrington|richboro|holland|penndel|croydon|tullytown|drexel hill|"
              "lansdowne|yeadon|collingdale|prospect park|norwood|morton|wallingford|boothwyn|linwood|"
              "brookhaven|parkside|narberth|merion|wyncote|cheltenham|dresher|maple glen|hatfield|"
              "red hill|pennsburg|green lane|zieglerville|graterford|worcester|",
        "NJ": "camden|cherry hill|mount laurel|moorestown|marlton|evesham|voorhees|haddonfield|collingswood|"
              "pennsauken|cinnaminson|burlington|bordentown|willingboro|mount holly|lumberton|medford|maple shade|"
              "delran|riverside|palmyra|sicklerville|berlin|gloucester city|deptford|woodbury|glassboro|sewell|"
              "mullica hill|swedesboro|logan township|paulsboro|west deptford|thorofare|bridgeport|pennsville|"
              "carneys point|salem|deepwater|joint base mcguire-dix-lakehurst|joint base mcguire dix lakehurst|"
              "mcguire afb|fort dix|edgewater park|westampton|florence|blackwood|turnersville|williamstown|"
              "pitman|clementon|lindenwold|stratford|somerdale|magnolia|runnemede|bellmawr|audubon|oaklyn|"
              "haddon heights|barrington|lawnside|gibbsboro|atco|waterford|winslow|cherry hill township|"
              "mount ephraim|national park|westville|clarksboro|gibbstown||elmer|woodstown|"
              "pedricktown|penns grove|riverton|beverly|delanco|burlington township|mansfield|columbus|"
              "chesterfield|new egypt|wrightstown|browns mills|pemberton|vincentown|tabernacle|"
              "shamong|southampton|hainesport|eastampton",
        "DE": "wilmington|newark|new castle|bear|middletown|claymont|hockessin|greenville|pike creek|christiana|"
              "delaware city|townsend|glasgow|odessa|elsmere|newport|stanton|yorklyn|montchanin|winterthur|"
              "rockland|edgemoor|talleyville|north star|st georges",
        "MD": "elkton|north east|perryville|rising sun|port deposit|chesapeake city|conowingo|charlestown|"
              "colora|earleville",
    },
    "38060": {  # Phoenix: Maricopa and Pinal
        "AZ": "phoenix|mesa|chandler|gilbert|tempe|scottsdale|glendale|peoria|surprise|goodyear|avondale|buckeye|"
              "tolleson|litchfield park|luke afb|el mirage|sun city|sun city west|fountain hills|paradise valley|"
              "cave creek|carefree|queen creek|apache junction|casa grande|maricopa|florence|coolidge|eloy|"
              "san tan valley|laveen|anthem|wickenburg|youngtown|guadalupe|gold canyon|sun lakes|new river|"
              "waddell|tonopah|gila bend|superior|kearny|mammoth|oracle|san manuel|arizona city|stanfield",
    },
    "14460": {  # Boston: Essex, Middlesex, Norfolk, Plymouth, Suffolk (MA); Rockingham, Strafford (NH)
        "MA": "boston|cambridge|somerville|brookline|newton|watertown|waltham|medford|malden|everett|chelsea|"
              "revere|winthrop|quincy|milton|dedham|needham|wellesley|wellesley hills|natick|framingham|"
              "lexington|bedford|burlington|woburn|winchester|arlington|belmont|lincoln|concord|acton|maynard|"
              "sudbury|wayland|weston|marlborough|hudson|stow|boxborough|littleton|westford|chelmsford|lowell|"
              "billerica|tewksbury|wilmington|dracut|tyngsborough|dunstable|pepperell|townsend|ashby|groton|"
              "ayer|shirley|devens|carlisle|hopkinton|holliston|sherborn|ashland|stoneham|wakefield|reading|"
              "north reading|melrose|saugus|lynn|lynnfield|peabody|salem|marblehead|swampscott|nahant|danvers|"
              "beverly|wenham|hamilton|ipswich|essex|gloucester|rockport|manchester-by-the-sea|manchester by the sea|"
              "topsfield|boxford|middleton|north andover|andover|lawrence|methuen|haverhill|groveland|"
              "georgetown|rowley|newbury|newburyport|west newbury|merrimac|amesbury|salisbury|norwood|westwood|"
              "canton|stoughton|sharon|walpole|norfolk|franklin|wrentham|plainville|foxborough|foxboro|medway|"
              "millis|medfield|dover|bellingham|braintree|weymouth|holbrook|randolph|avon|cohasset|"
              "brockton|whitman|abington|rockland|hanover|hingham|hull|scituate|norwell|marshfield|pembroke|"
              "duxbury|kingston|plymouth|carver|plympton|halifax|hanson|east bridgewater|west bridgewater|"
              "bridgewater|middleborough|middleboro|lakeville|wareham|marion|mattapoisett|rochester|"
              "hanscom|hanscom afb|chestnut hill|brighton|allston|dorchester|roxbury|jamaica plain|"
              "charlestown|south boston|east boston|hyde park|roslindale|west roxbury|mattapan|"
              "back bay|seaport|kendall square|newton center|newton highlands|newtonville|auburndale|"
              "west newton|waban|needham heights|lexington|north billerica|north chelmsford|south weymouth|"
              "east weymouth|north weymouth|woburn|burlington|boxboro||manomet|"
              "|",
        "NH": "portsmouth|dover|rochester|somersworth|durham|exeter|hampton|salem|derry|londonderry|windham|"
              "seabrook|newmarket|stratham|north hampton|rye|new castle|raymond|epping|plaistow|atkinson|"
              "hampstead|kingston|newington|greenland|barrington|lee|farmington|milton|pease|"
              "hampton falls|east kingston|kensington|south hampton|newton|danville|fremont|sandown|"
              "chester|auburn|candia|deerfield|northwood|nottingham|brentwood|newfields|madbury|"
              "rollinsford|strafford|new durham|middleton",
    },
    "40140": {  # Riverside-San Bernardino-Ontario: Riverside and San Bernardino counties
        "CA": "riverside|san bernardino|ontario|corona|fontana|rancho cucamonga|moreno valley|temecula|murrieta|"
              "menifee|jurupa valley|eastvale|norco|chino|chino hills|upland|montclair|redlands|loma linda|colton|"
              "rialto|highland|yucaipa|hesperia|victorville|apple valley|adelanto|barstow|palm springs|palm desert|"
              "indio|la quinta|cathedral city|rancho mirage|coachella|desert hot springs|hemet|san jacinto|perris|"
              "lake elsinore|wildomar|beaumont|banning|calimesa|twentynine palms|yucca valley|big bear lake|"
              "fort irwin|march arb|march air reserve base|mira loma|bloomington|grand terrace|needles|"
              "mentone|lucerne valley|phelan|oak hills|wrightwood|crestline|lake arrowhead|running springs|"
              "joshua tree|thermal|mecca|blythe|indian wells|winchester|nuevo|sun city|canyon lake|"
              "french valley|aguanga|anza|idyllwild|cherry valley",
    },
    "41860": {  # San Francisco-Oakland-Fremont: San Francisco, San Mateo, Alameda, Contra Costa, Marin
        "CA": "san francisco|sf|oakland|berkeley|emeryville|alameda|fremont|newark|union city|hayward|san leandro|"
              "castro valley|dublin|pleasanton|livermore|albany|piedmont|san lorenzo|san ramon|danville|"
              "walnut creek|concord|pleasant hill|martinez|lafayette|orinda|moraga|richmond|el cerrito|san pablo|"
              "pinole|hercules|antioch|pittsburg|brentwood|oakley|clayton|san mateo|foster city|redwood city|"
              "redwood shores|menlo park|belmont|san carlos|burlingame|millbrae|san bruno|south san francisco|"
              "daly city|brisbane|pacifica|half moon bay|east palo alto|atherton|woodside|portola valley|"
              "hillsborough|san rafael|novato|mill valley|sausalito|larkspur|corte madera|tiburon|greenbrae|"
              "colma|el granada|montara|moss beach|san anselmo|fairfax|kentfield|ross|belvedere|"
              "rodeo|crockett|el sobrante|kensington|alamo|discovery bay|byron|bay point|sunol|"
              "ashland|cherryland|fairview|west menlo park|broadmoor|ladera|emerald hills",
    },
    "19820": {  # Detroit: Wayne, Oakland, Macomb, Livingston, Lapeer, St. Clair
        "MI": "detroit|warren|dearborn|dearborn heights|livonia|troy|southfield|farmington hills|farmington|novi|"
              "auburn hills|pontiac|rochester hills|rochester|bloomfield hills|bloomfield|birmingham|royal oak|"
              "ferndale|madison heights|sterling heights|clinton township|macomb|shelby township|utica|"
              "mount clemens|roseville|st clair shores|eastpointe|grosse pointe|grosse pointe farms|"
              "grosse pointe park|grosse pointe woods|hamtramck|highland park|allen park|taylor|romulus|"
              "wyandotte|southgate|lincoln park|trenton|woodhaven|flat rock|brownstown|belleville|canton|"
              "plymouth|northville|westland|garden city|redford|inkster|wixom|commerce township|commerce|"
              "walled lake|milford|highland|white lake|waterford|clarkston|lake orion|oxford|orion|sylvan lake|"
              "keego harbor|west bloomfield|lathrup village|oak park|berkley|clawson|chesterfield|new baltimore|"
              "new haven|port huron|marysville|howell|brighton|hartland|fowlerville|new hudson|lapeer|holly|"
              "selfridge|harper woods|grosse ile|riverview|ecorse|river rouge|melvindale|van buren|"
              "huntington woods|pleasant ridge|beverly hills|franklin|bingham farms|orchard lake|wolverine lake|"
              "lyon township|south lyon|ortonville|goodrich|imlay city|almont|richmond|armada|romeo|"
              "washington township|ray|harrison township|st clair|marine city|algonac|pinckney|"
              "whitmore lake||metamora",
    },
    "42660": {  # Seattle: King, Pierce, Snohomish
        "WA": "seattle|bellevue|redmond|kirkland|bothell|renton|tukwila|kent|auburn|federal way|seatac|burien|"
              "des moines|normandy park|mercer island|issaquah|sammamish|woodinville|kenmore|shoreline|"
              "lake forest park|lynnwood|edmonds|mountlake terrace|mukilteo|everett|marysville|arlington|"
              "lake stevens|snohomish|monroe|mill creek|tacoma|lakewood|puyallup|fife|sumner|bonney lake|"
              "gig harbor|university place|dupont|joint base lewis-mcchord|joint base lewis mcchord|fort lewis|"
              "mcchord|spanaway|maple valley|covington|enumclaw|north bend|snoqualmie|duvall|carnation|"
              "black diamond|newcastle|medina|clyde hill|yarrow point|hunts point|beaux arts|algona|pacific|"
              "milton|edgewood|steilacoom|parkland|frederickson|graham|orting|eatonville|buckley|"
              "brier|woodway|stanwood|granite falls|sultan|gold bar|lake tapps|vashon|white center|"
              "boeing field",
    },
    "33460": {  # Minneapolis-St. Paul: the Minnesota counties of the MSA, and Pierce and St. Croix (WI)
        "MN": "minneapolis|st paul|twin cities|bloomington|eden prairie|minnetonka|edina|richfield|st louis park|golden valley|"
              "plymouth|maple grove|brooklyn park|brooklyn center|crystal|new hope|robbinsdale|fridley|coon rapids|"
              "blaine|anoka|ramsey|andover|champlin|rogers|dayton|medina|wayzata|hopkins|chanhassen|chaska|"
              "shakopee|prior lake|savage|burnsville|eagan|apple valley|lakeville|inver grove heights|"
              "south st paul|west st paul|mendota heights|mendota|woodbury|maplewood|oakdale|lake elmo|stillwater|"
              "cottage grove|st paul park|forest lake|hugo|white bear lake|roseville|shoreview|arden hills|"
              "new brighton|mounds view|vadnais heights|little canada|falcon heights|lauderdale|st anthony|"
              "columbia heights|hastings|farmington|rosemount|elk river|otsego|monticello|buffalo|big lake|"
              "albertville|st michael|delano|waconia|victoria|belle plaine|jordan|north branch|cambridge|"
              "isanti|princeton|le sueur|wyoming|lino lakes|ham lake|east bethel|oak grove|st francis|"
              "spring lake park|mound|orono|minnetrista|excelsior|shorewood|long lake|maple plain|"
              "corcoran|loretto|hanover|st bonifacius|watertown|mayer|norwood young america|carver|"
              "new prague|lonsdale|elko new market|north st paul|mahtomedi|bayport|afton|lakeland|"
              "scandia|marine on st croix|chisago city|lindstrom|center city|rush city|harris|stacy|"
              "zimmerman|becker|clear lake|annandale|cokato|howard lake|waverly|montrose|rockford|"
              "|fort snelling|mall of america||",
        "WI": "hudson|river falls|new richmond|prescott|somerset|baldwin|ellsworth|north hudson|roberts|"
              "hammond|woodville|spring valley|glenwood city",
    },
    "45300": {  # Tampa: Hillsborough, Pinellas, Pasco, Hernando
        "FL": "tampa|st petersburg|st pete|clearwater|largo|pinellas park|dunedin|palm harbor|tarpon springs|"
              "oldsmar|safety harbor|seminole|st pete beach|treasure island|brandon|riverview|plant city|"
              "temple terrace|lutz|wesley chapel|land o lakes|land o' lakes|new port richey|port richey|"
              "zephyrhills|dade city|brooksville|spring hill|ruskin|apollo beach|sun city center|valrico|seffner|"
              "gibsonton|macdill afb|macdill|odessa|trinity|holiday|hudson|thonotosassa|dover|lithia|"
              "fish hawk|wimauma|kenneth city|gulfport|madeira beach|indian rocks beach|belleair|"
              "south pasadena|redington shores|weeki wachee|ridge manor|san antonio|carrollwood|"
              "town n country|westchase|citrus park|keystone",
    },
    "41740": {  # San Diego County
        "CA": "san diego|chula vista|carlsbad|oceanside|escondido|el cajon|vista|san marcos|encinitas|la mesa|"
              "santee|national city|poway|la jolla|del mar|solana beach|coronado|imperial beach|lemon grove|"
              "rancho bernardo|rancho santa fe|spring valley|lakeside|ramona|fallbrook|camp pendleton|miramar|"
              "sorrento valley|kearny mesa|otay mesa|bonita|alpine|cardiff|leucadia|olivenhain|"
              "rancho penasquitos|mira mesa|scripps ranch|carmel valley|university city|point loma|"
              "san ysidro|valley center|borrego springs|julian|jamul|pine valley|bonsall|pala|pauma valley|"
              "4s ranch|del mar heights",
    },
    "19740": {  # Denver: Denver, Arapahoe, Jefferson, Adams, Douglas, Broomfield, Elbert, Park, Clear Creek, Gilpin (Boulder is its own metro)
        "CO": "denver|aurora|lakewood|littleton|englewood|centennial|greenwood village|lone tree|highlands ranch|"
              "parker|castle rock|castle pines|golden|arvada|westminster|thornton|northglenn|broomfield|"
              "commerce city|brighton|federal heights|wheat ridge|edgewater|sheridan|glendale|"
              "cherry hills village|morrison|evergreen|conifer|louviers|henderson|buckley afb|buckley sfb|"
              "buckley space force base|denver international airport|denver metro|idaho springs|black hawk|"
              "central city|elizabeth|kiowa|bennett|watkins|strasburg|byers|foxfield|bow mar|columbine|"
              "ken caryl|sedalia|franktown|larkspur|bailey|fairplay|georgetown|empire|dupont|"
              "applewood|lakeside|mountain view|superior arvada|deer trail|keenesburg",
    },
    "36740": {  # Orlando: Orange, Osceola, Lake, Seminole
        "FL": "orlando|kissimmee|sanford|lake mary|altamonte springs|apopka|winter park|winter garden|ocoee|"
              "maitland|casselberry|longwood|oviedo|winter springs|clermont|leesburg|tavares|mount dora|eustis|"
              "celebration|st cloud|lake buena vista|windermere|heathrow|lake nona|poinciana|groveland|minneola|"
              "mascotte|umatilla|fruitland park|lady lake|howey-in-the-hills|howey in the hills|montverde|"
              "astatula|belle isle|edgewood|eatonville|oakland|zellwood|christmas|bithlo|chuluota|geneva|"
              "fern park|goldenrod|harmony|davenport|four corners|the villages|sorrento|mount plymouth",
    },
    "16740": {  # Charlotte: the North Carolina counties of the MSA, and York, Lancaster, Chester (SC)
        "NC": "charlotte|concord|gastonia|huntersville|cornelius|davidson|matthews|mint hill|pineville|monroe|"
              "indian trail|waxhaw|wesley chapel|stallings|weddington|harrisburg|kannapolis|mooresville|"
              "statesville|salisbury|china grove|lincolnton|denver|belmont|mount holly|cramerton|lowell|dallas|"
              "bessemer city|cherryville|troutman|locust|midland|mount pleasant|landis|rockwell|granite quarry|"
              "spencer|east spencer|cleveland|marvin|wingate|marshville|unionville|fairview|hemby bridge|"
              "lake norman|stanley|ranlo|mcadenville||iron station|crouse|lake park",
        "SC": "rock hill|fort mill|tega cay|york|clover|lake wylie|lancaster|indian land|chester|great falls|"
              "kershaw|heath springs|hickory grove|sharon|smyrna|mcconnells|richburg|catawba",
    },
    "12580": {  # Baltimore: Baltimore city and county, Anne Arundel, Carroll, Harford, Howard, Queen Anne's
        "MD": "baltimore|towson|columbia|ellicott city|annapolis|annapolis junction|glen burnie|linthicum|"
              "linthicum heights|hanover|severn|odenton|crofton|millersville|pasadena|fort meade|"
              "fort george g meade|jessup|elkridge|laurel|owings mills|reisterstown|pikesville|catonsville|"
              "arbutus|halethorpe|lansdowne|dundalk|essex|middle river|white marsh|nottingham|perry hall|"
              "parkville|cockeysville|hunt valley|timonium|lutherville|lutherville-timonium|sparks|hampstead|"
              "westminster|eldersburg|sykesville|finksburg|manchester|bel air|aberdeen|aberdeen proving ground|"
              "havre de grace|edgewood|joppa|abingdon|belcamp|perryman|darlington|fallston|forest hill|"
              "churchville|stevensville|centreville|kent island|grasonville|chester|queenstown|fulton|"
              "clarksville|maple lawn|savage|bwi|bwi airport|gwynn oak|windsor mill|woodlawn|randallstown|"
              "rosedale|kingsville|baldwin|glen arm|phoenix|monkton|glyndon|upperco|hampstead|taneytown|"
              "new windsor|union bridge|mount airy|woodbine|marriottsville|glenwood|highland|dayton|"
              "cooksville|west friendship|brooklandville|stevenson|riderwood|ruxton|severna park|arnold|"
              "pasadena|gambrills|davidsonville|edgewater|deale|shady side|curtis bay|brooklyn park|"
              "ferndale|harmans|hanover|bel air south|street|pylesville|white hall|freeland",
    },
    "41180": {  # St. Louis: the Missouri and Illinois counties of the MSA
        "MO": "st louis|clayton|creve coeur|chesterfield|maryland heights|hazelwood|florissant|bridgeton|berkeley|"
              "earth city|st ann|overland|university city|webster groves|kirkwood|des peres|town and country|"
              "ballwin|ellisville|wildwood|manchester|fenton|sunset hills|crestwood|affton|mehlville|arnold|"
              "festus|crystal city|hillsboro|st charles|o'fallon|st peters|wentzville|lake st louis|cottleville|"
              "dardenne prairie|weldon spring|washington|pacific|union|troy|warrenton|maplewood|brentwood|"
              "richmond heights|ladue|olivette|frontenac|rock hill|normandy|ferguson|bellefontaine neighbors|"
              "jennings|black jack|spanish lake|lambert|st louis maplewood|valley park|eureka|grover|"
              "high ridge|house springs|imperial|barnhart|herculaneum|pevely|de soto|town & country|"
              "shrewsbury|lemay|oakville|concord|green park|marlborough|glendale|rock hill|"
              "berkeley|woodson terrace|edmundson|st john|breckenridge hills|sappington|"
              "foristell|new melle|defiance|augusta|st clair||||winfield|elsberry|"
              "moscow mills|wright city|foley|ballwin|pacific",
        "IL": "east st louis|belleville|o'fallon|fairview heights|collinsville|edwardsville|granite city|alton|"
              "godfrey|wood river|glen carbon|maryville|troy|highland|swansea|mascoutah|shiloh|scott afb|"
              "scott air force base|lebanon|columbia|waterloo|cahokia|cahokia heights|sauget|dupo|millstadt|"
              "freeburg|carlyle|breese|trenton|jerseyville|carlinville|greenville|east alton|roxana|"
              "hartford|bethalto|caseyville|o'fallon il|smithton|new baden|aviston|germantown|"
              "staunton|gillespie|bunker hill|grafton|hardin|pocahontas|marine|st jacob|worden|"
              "pontoon beach|madison|venice|brooklyn|washington park|east carondelet",
    },
    "41700": {  # San Antonio: Bexar, Comal, Guadalupe, Medina, Wilson, Atascosa, Bandera, Kendall
        "TX": "san antonio|new braunfels|schertz|seguin|cibolo|converse|universal city|live oak|selma|kirby|"
              "leon valley|alamo heights|helotes|boerne|castroville|hondo|floresville|pleasanton|jourdanton|"
              "bandera|lackland afb|randolph afb|joint base san antonio|jbsa|fort sam houston|brooks city base|"
              "windcrest|garden ridge|canyon lake|bulverde|la vernia|lytle||devine|poteet|charlotte|"
              "von ormy|somerset|elmendorf|st hedwig|china grove|marion|stockdale|comfort|spring branch|"
              "shavano park|hollywood park|olmos park|terrell hills|balcones heights|castle hills|"
              "fair oaks ranch|timberwood park|stone oak|alamo ranch",
    },
    "12420": {  # Austin: Travis, Williamson, Hays, Bastrop, Caldwell
        "TX": "austin|round rock|cedar park|georgetown|pflugerville|taylor|leander|san marcos|kyle|buda|hutto|"
              "lakeway|bee cave|west lake hills|manor|del valle|dripping springs|bastrop|elgin|lockhart|"
              "liberty hill|jarrell|wimberley|lago vista|sunset valley|rollingwood|jonestown|volente|"
              "briarcliff|spicewood|smithville|cedar creek|luling|martindale|uhland|niederwald|"
              "florence|granger|thrall|coupland|weir|brushy creek|anderson mill|wells branch|"
              "steiner ranch|bergstrom",
    },
    "38900": {  # Portland: Multnomah, Washington, Clackamas, Columbia, Yamhill (OR); Clark, Skamania (WA)
        "OR": "portland|hillsboro|beaverton|gresham|lake oswego|tigard|tualatin|wilsonville|oregon city|"
              "west linn|milwaukie|happy valley|clackamas|sherwood|forest grove|cornelius|troutdale|fairview|"
              "wood village|gladstone|canby|molalla|sandy|estacada|mcminnville|newberg|dundee|st helens|"
              "scappoose|aloha|north plains|banks|king city|damascus|boring|mulino|oak grove|sunnyside|"
              "rainier|clatskanie|vernonia|columbia city|lafayette|carlton|yamhill|amity|sheridan|willamina|"
              "dayton|gaston|corbett|welches|rhododendron|tualatin valley|bethany|cedar mill|"
              "lake oswego north|lake oswego south",
        "WA": "vancouver|camas|washougal|battle ground|ridgefield|la center|stevenson|north bonneville|"
              "carson|yacolt|amboy|brush prairie|hockinson|salmon creek|orchards|hazel dell|felida",
    },
    "40900": {  # Sacramento: Sacramento, Placer, El Dorado, Yolo
        "CA": "sacramento|roseville|folsom|rancho cordova|elk grove|citrus heights|rocklin|lincoln|auburn|"
              "granite bay|el dorado hills|placerville|cameron park|shingle springs|davis|woodland|"
              "west sacramento|winters|carmichael|fair oaks|orangevale|north highlands|antelope|rio linda|galt|"
              "mather|mcclellan|mcclellan park|south lake tahoe|loomis|newcastle|penryn|colfax|"
              "diamond springs|pollock pines|georgetown|cool|esparto|knights landing|clarksburg|"
              "elverta|wilton|herald|isleton|walnut grove|courtland|sloughhouse|gold river|arden-arcade|"
              "arden arcade|natomas|kings beach|tahoe city|olympic valley|meadow vista|sheridan",
    },
    "38300": {  # Pittsburgh: Allegheny, Armstrong, Beaver, Butler, Fayette, Washington, Westmoreland
        "PA": "pittsburgh|canonsburg|cranberry|cranberry township|coraopolis|moon township|moon|warrendale|"
              "murrysville|bridgeville|wexford|monroeville|mckeesport|bethel park|mount lebanon|upper st clair|"
              "south park|west mifflin|homestead|munhall|carnegie|robinson township|oakdale|sewickley|gibsonia|"
              "allison park|mars|butler|zelienople|evans city|beaver|beaver falls|aliquippa|ambridge|monaca|"
              "new brighton|rochester|cheswick|harmarville|blawnox|oakmont|verona|plum|natrona heights|tarentum|"
              "new kensington|lower burrell|greensburg|latrobe|jeannette|irwin|north huntingdon|delmont|export|"
              "mount pleasant|scottdale|connellsville|uniontown|washington|houston|meadow lands|mcmurray|"
              "peters township|eighty four|charleroi|monongahela|kittanning|ford city|leechburg|freeport|"
              "glenshaw|bellevue|mckees rocks|crafton|green tree|castle shannon|baldwin|whitehall|"
              "pleasant hills|jefferson hills|clairton|elizabeth|duquesne|braddock|turtle creek|"
              "wilkinsburg|edgewood|swissvale|forest hills|penn hills|fox chapel|aspinwall|sharpsburg|"
              "etna|millvale|ross township|mccandless|franklin park|imperial|oakmont|leetsdale|"
              "bridgewater|hopewell|center township|chippewa|darlington|koppel|ellwood city|"
              "slippery rock|saxonburg|prospect|chicora|seven fields|adams township|valencia|"
              "harmony|new stanton|youngwood||derry|ligonier|vandergrift|apollo|"
              "belle vernon|rostraver|perryopolis|brownsville|masontown|fairchance|smithfield|"
              "point marion|ohiopyle||bentleyville|burgettstown|claysville|avella|"
              "finleyville|cecil|lawrence|venetia|hickory|west newton|sutersville||"
              "|bulger",
    },
    "29820": {  # Las Vegas: Clark County
        "NV": "las vegas|henderson|north las vegas|paradise|spring valley|enterprise|summerlin|boulder city|"
              "mesquite|nellis afb|nellis|creech afb|sunrise manor|whitney|winchester|mccarran|harry reid|"
              "laughlin|moapa|overton|logandale|indian springs|blue diamond|sandy valley|searchlight|"
              "mount charleston",
    },
    "17140": {  # Cincinnati: the Ohio, Kentucky and Indiana counties of the MSA
        "OH": "cincinnati|blue ash|mason|west chester|west chester township|sharonville|evendale|fairfield|hamilton|"
              "middletown|oxford|lebanon|springboro|loveland|milford|batavia|amelia|norwood|reading|montgomery|"
              "kenwood|madeira|mariemont|deer park|forest park|springdale|harrison|cleves|north bend|monroe|"
              "trenton|franklin|waynesville|maineville|kings mills|liberty township|hamilton township|"
              "union township|georgetown|mount orab|eastgate|cherry grove|anderson township|"
              "fairfax|terrace park|indian hill|wyoming|lockland|arlington heights|glendale|woodlawn|"
              "lincoln heights|evendale|st bernard|elmwood place|golf manor|silverton|amberley|"
              "mount healthy|north college hill|finneytown|colerain|white oak|green township|delhi|"
              "addyston|harrison township|ross|okeana|new miami|seven mile|somerville|trenton|"
              "landen|morrow|south lebanon|carlisle|pleasant plain|goshen|owensville|new richmond|"
              "bethel|felicity|williamsburg|ripley|aberdeen|higginsport|fayetteville|sardinia|"
              "|mount repose|miamiville|camp dennison|newtown|terrace park|mount carmel",
        "KY": "cincinnati|greater cincinnati|covington|newport|florence|erlanger|hebron|burlington|union|"
              "independence|fort mitchell|fort thomas|fort wright|highland heights|cold spring|alexandria|"
              "crescent springs|villa hills|edgewood|elsmere|walton|williamstown|dry ridge|bellevue|dayton|"
              "ludlow|wilder|southgate|taylor mill|park hills|lakeside park|crestview hills|melbourne|"
              "silver grove||petersburg|verona|crittenden|corinth|falmouth|butler|"
              "augusta|brooksville|warsaw|sparta|cvg|cincinnati airport",
        "IN": "lawrenceburg|aurora|greendale|brookville|rising sun|dillsboro|moores hill|st leon|"
              "bright|guilford|west harrison|cedar grove|oldenburg",
    },
    "28140": {  # Kansas City: the Missouri and Kansas counties of the MSA
        "MO": "kansas city|north kansas city|independence|lee's summit|lees summit|blue springs|grandview|raytown|"
              "gladstone|liberty|kearney|smithville|parkville|riverside|platte city|belton|raymore|"
              "harrisonville|peculiar|grain valley|oak grove|excelsior springs|northmoor|sugar creek|"
              "lake lotawana|richmond|lexington|pleasant hill|greenwood|lone jack|buckner|sibley|"
              "claycomo|pleasant valley|weatherby lake|platte woods|houston lake|lake waukomis|"
              "ferrelview|camden point|weston|dearborn|edgerton|holt|lawson|orrick|"
              "garden city|archie|drexel|cleveland|freeman|odessa|higginsville|wellington|"
              "napoleon|concordia|corder|butler|adrian|plattsburg|lathrop|cameron|"
              "kansas city mo|kansas city downtown",
        "KS": "kansas city|overland park|olathe|lenexa|shawnee|leawood|merriam|mission|prairie village|"
              "roeland park|fairway|de soto|gardner|edgerton|spring hill|bonner springs|leavenworth|"
              "fort leavenworth|lansing|tonganoxie|basehor|paola|osawatomie|louisburg|new century|"
              "mission hills|westwood|westwood hills|lake quivira|edwardsville|linwood||"
              "stilwell|bucyrus|spring hill||fontana|pleasanton|mound city|la cygne|"
              "kansas city ks",
    },
    "18140": {  # Columbus, OH: Franklin, Delaware, Fairfield, Licking, Madison, Morrow, Pickaway, Union, Hocking, Perry
        "OH": "columbus|westerville|dublin|hilliard|worthington|upper arlington|grandview heights|grandview|bexley|"
              "gahanna|reynoldsburg|whitehall|new albany|grove city|groveport|canal winchester|pickerington|"
              "lancaster|delaware|powell|lewis center|sunbury|galena|marysville|plain city|london|"
              "west jefferson|newark|heath|granville|pataskala|johnstown|circleville|ashville|logan|"
              "new lexington|mount gilead|obetz|lockbourne|rickenbacker|minerva park|blacklick|"
              "urbancrest|valleyview|marble cliff|riverlea|harrisburg|commercial point|orient|"
              "baltimore|carroll|lithopolis|millersport|thornville|somerset|new lexington|junction city|"
              "buckeye lake|hebron|utica|alexandria||hanover|st louisville|ostrander|"
              "ashley|cardington|marengo|richwood|milford center|magnetic springs|mount sterling|"
              "south bloomfield|williamsport|new holland|laurelville||murray city|"
              "east columbus|north columbus",
    },
    "26900": {  # Indianapolis: the Indiana counties of the MSA
        "IN": "indianapolis|indy|carmel|fishers|noblesville|westfield|zionsville|lebanon|whitestown|brownsburg|"
              "avon|plainfield|danville|greenwood|franklin|greenfield|mount comfort|mccordsville|fortville|"
              "anderson|pendleton|martinsville|mooresville|shelbyville|greencastle|nashville|lawrence|speedway|"
              "beech grove|camby|cicero|arcadia||elwood|whiteland|new whiteland|bargersville|"
              "edinburgh|trafalgar|morgantown|cumberland|new palestine|||"
              "sheridan|atlanta|lapel|ingalls|frankton|chesterfield|alexandria|summitville|"
              "pittsboro|lizton|north salem|clayton|coatesville|stilesville|monrovia|bainbridge|"
              "roachdale|cloverdale|eminence|paragon|morristown|fairland|waldron|thorntown|jamestown|"
              "advance||||oaklandon|castleton|irvington|broad ripple",
    },
    "34980": {  # Nashville: the Tennessee counties of the MSA
        "TN": "nashville|franklin|brentwood|murfreesboro|smyrna|la vergne|lavergne|mount juliet|lebanon|"
              "hendersonville|gallatin|goodlettsville|madison|antioch|hermitage|old hickory|spring hill|columbia|"
              "thompson's station|thompsons station|nolensville|fairview|dickson|ashland city|springfield|"
              "white house|portland|greenbrier|kingston springs|pegram|bna|bellevue|joelton|whites creek|"
              "millersville|westmoreland|lafayette|hartsville|carthage|gordonsville|woodbury|centerville|"
              "eagleville|christiana|rockvale|lascassas|watertown|mount pleasant|culleoka|santa fe|"
              "burns|white bluff|charlotte|cross plains|coopertown|ridgetop|adams|cedar hill|"
              "arrington|college grove|leipers fork|thompson station|bon aqua|chapmansboro",
    },
    "17410": {  # Cleveland: Cuyahoga, Geauga, Lake, Lorain, Medina (Akron is its own metro)
        "OH": "cleveland|lakewood|parma|parma heights|euclid|cleveland heights|shaker heights|east cleveland|"
              "beachwood|mayfield heights|mayfield village|mayfield|lyndhurst|south euclid|richmond heights|"
              "highland heights|solon|independence|brecksville|broadview heights|seven hills|north royalton|"
              "strongsville|berea|middleburg heights|brook park|brookpark|north olmsted|westlake|bay village|"
              "rocky river|fairview park|olmsted falls|valley view|garfield heights|maple heights|bedford|"
              "bedford heights|warrensville heights|mentor|painesville|willoughby|willoughby hills|eastlake|"
              "wickliffe|kirtland|madison|perry|chardon|chesterland|middlefield|burton|elyria|lorain|avon|"
              "avon lake|north ridgeville|sheffield village|sheffield lake|amherst|oberlin|wellington|grafton|"
              "medina|brunswick|wadsworth|valley city|seville|lodi|westfield center|chippewa lake|"
              "university heights|pepper pike|orange|moreland hills|hunting valley|gates mills|"
              "highland hills|bentleyville|chagrin falls|bratenahl|cuyahoga heights|newburgh heights|"
              "brooklyn|brooklyn heights|linndale|walton hills|oakwood|glenwillow|north randall|"
              "columbia station|lagrange||kipton|south amherst||"
              "mentor-on-the-lake|mentor on the lake|timberlake|lakeline|willowick|north perry|"
              "fairport harbor|grand river|leroy|concord|newbury|munson|bainbridge|auburn|"
              "russell|thompson|montville|hambden|parkman|huntsburg|claridon|hinckley|"
              "litchfield|spencer|homerville|sharon|gloria glens|cleveland clinic|"
              "cleveland clinic main campus|marymount hospital|fairview hospital",
    },
    "41940": {  # San Jose: Santa Clara and San Benito
        "CA": "san jose|sunnyvale|santa clara|palo alto|mountain view|cupertino|milpitas|campbell|los gatos|"
              "saratoga|los altos|los altos hills|morgan hill|gilroy|stanford|moffett field|alviso|monte sereno|"
              "hollister|san martin|san juan bautista|tres pinos|aromas|coyote|east foothills|"
              "cambrian park|fruitdale|loyola|lexington hills|north san jose|berryessa|evergreen",
    },
    "47260": {  # Virginia Beach-Chesapeake-Norfolk: the Virginia localities of the MSA, and Currituck, Camden, Gates (NC)
        "VA": "virginia beach|norfolk|chesapeake|portsmouth|suffolk|hampton|newport news|williamsburg|yorktown|"
              "poquoson|smithfield|gloucester|gloucester point|isle of wight|james city|"
              "joint base langley-eustis|joint base langley eustis|langley afb|fort eustis|naval station norfolk|"
              "dam neck|oceana|nas oceana|little creek|fort story|carrollton|windsor|zuni|seaford|grafton|"
              "|||||||mathews|hayes|"
              "surry||franklin|courtland|boykins|branchville|capron|ivor|tabb",
        "NC": "moyock|currituck|camden|gates|gatesville|knotts island|grandy|jarvisburg|point harbor|"
              "shiloh|south mills|sunbury|corolla|powells point|harbinger|coinjock",
    },
    "27260": {  # Jacksonville, FL: Duval, Clay, St. Johns, Nassau, Baker
        "FL": "jacksonville|jax|jacksonville beach|atlantic beach|neptune beach|ponte vedra|ponte vedra beach|"
              "st augustine|st johns|nocatee|orange park|fleming island|green cove springs|middleburg|"
              "fernandina beach|yulee|callahan|macclenny|mayport|naval air station jacksonville|"
              "nas jacksonville|baldwin|hilliard|keystone heights|penney farms|oakleaf|"
              "st augustine beach|hastings|elkton|world golf village|palm valley|glen st mary|"
              "sanderson|amelia island|bryceville|julington creek|mandarin|southside|arlington|"
              "baymeadows|riverside|san marco|cecil field",
    },
    "39300": {  # Providence: all of Rhode Island, and Bristol County (MA)
        "RI": "providence|warwick|cranston|pawtucket|east providence|woonsocket|coventry|cumberland|"
              "north providence|south kingstown|west warwick|johnston|north kingstown|newport|bristol|westerly|"
              "smithfield|lincoln|central falls|portsmouth|barrington|middletown|burrillville|narragansett|"
              "tiverton|east greenwich|north smithfield|warren|scituate|glocester|hopkinton|charlestown|"
              "richmond|west greenwich|jamestown|exeter|foster|little compton|new shoreham|block island|"
              "kingston|wakefield|quonset|quonset point|davisville|peace dale|greenville|harrisville|"
              "pascoag|chepachet|esmond|riverside|rumford|saylesville|valley falls|ashaway|hope valley|"
              "wyoming|carolina|shannock|charlestown|watch hill|misquamicut|saunderstown|wickford|"
              "slatersville|forestdale|manville|albion|lonsdale|hope|fiskeville|clayville|north scituate|"
              "anthony|apponaug|pawtuxet|oakland beach|conimicut",
        "MA": "fall river|new bedford|taunton|attleboro|north attleborough|north attleboro|mansfield|norton|"
              "easton|raynham|seekonk|swansea|somerset|dartmouth|north dartmouth|south dartmouth|fairhaven|"
              "westport|acushnet|freetown|east freetown|assonet|berkley|dighton|north dighton|rehoboth|"
              "north easton|south easton|south attleboro|east taunton|east mansfield",
    },
    "39580": {  # Raleigh-Cary: Wake, Johnston, Franklin (Durham and RTP are the Durham-Chapel Hill metro)
        "NC": "raleigh|cary|apex|morrisville|holly springs|fuquay varina|wake forest|garner|knightdale|wendell|"
              "zebulon|rolesville|clayton|smithfield|selma|benson|louisburg|youngsville|wake county|"
              "new hill|willow spring|angier|four oaks|kenly|pine level|princeton|micro|archer lodge|"
              "franklinton|bunn|castalia|centerville|raleigh-durham",
    },
    "33340": {  # Milwaukee: Milwaukee, Waukesha, Ozaukee, Washington
        "WI": "milwaukee|waukesha|wauwatosa|west allis|brookfield|new berlin|greenfield|oak creek|franklin|"
              "south milwaukee|cudahy|st francis|glendale|shorewood|whitefish bay|fox point|brown deer|"
              "menomonee falls|germantown|mequon|cedarburg|grafton|port washington|west bend|hartford|pewaukee|"
              "delafield|oconomowoc|hartland|sussex|muskego|mukwonago|elm grove|butler|hales corners|greendale|"
              "west milwaukee|saukville|richfield|jackson|slinger|thiensville|bayside|river hills|"
              "big bend|vernon|eagle|north prairie|wales|dousman|genesee|lannon|merton|chenequa|"
              "nashotah|lac la belle|okauchee|colgate|hubertus|kewaskum|allenton|newburg|belgium|fredonia",
    },
    "36420": {  # Oklahoma City: Oklahoma, Cleveland, Canadian, Logan, McClain, Grady, Lincoln
        "OK": "oklahoma city|okc|edmond|norman|moore|midwest city|del city|yukon|mustang|el reno|guthrie|purcell|"
              "chickasha|choctaw|bethany|warr acres|the village|nichols hills|newcastle|blanchard|tuttle|"
              "piedmont|harrah|jones|spencer|tinker afb|tinker air force base|chandler|noble|lexington|"
              "luther|arcadia|forest park|lake aluma|valley brook|smith village|woodlawn park|"
              "nicoma park|slaughterville|washington|wayne|goldsby|dibble|minco|tuttle|ninnekah|"
              "rush springs|alex|amber|bridge creek|union city|calumet|okarche|crescent|langston|"
              "mulhall|meridian|coyle|stroud|prague|davenport|wellston|meeker|sparks|carney",
    },
    "31140": {  # Louisville: the Kentucky and Indiana counties of the MSA
        "KY": "louisville|jeffersontown|st matthews|shively|lyndon|middletown|anchorage|prospect|fern creek|"
              "okolona|valley station|pleasure ridge park|shepherdsville|mount washington|hillview|"
              "lebanon junction|la grange|crestwood|pewee valley|shelbyville|simpsonville|taylorsville|bedford|"
              "eminence|new castle|audubon park|buckner|goshen|brownsboro|fisherville|"
              "louisville airport|sdf|smithfield|campbellsburg|pleasureville|milton|"
              "brooks|fairdale|pioneer village|hebron estates|mount washington|"
              "graymoor-devondale|indian hills|douglass hills|hurstbourne|forest hills|"
              "highview|newburg|buechel|camp taylor|beechwood village|westport|ballardsville",
        "IN": "jeffersonville|clarksville|new albany|sellersburg|charlestown|corydon|scottsburg|salem|"
              "floyds knobs|georgetown|borden|henryville|memphis|utica|elizabeth|lanesville|palmyra|"
              "new salisbury|ramsey|depauw|austin|lexington|little york|pekin|campbellsburg|"
              "greenville|galena|starlight|marysville|otisco|nabb|new washington|crandall",
    },
    "40060": {  # Richmond, VA: the Virginia localities of the MSA
        "VA": "richmond|glen allen|short pump|henrico|chesterfield|midlothian|mechanicsville|ashland|hanover|"
              "petersburg|colonial heights|hopewell|chester|sandston|highland springs|varina|goochland|powhatan|"
              "prince george|fort lee|fort gregg-adams|fort gregg adams|dinwiddie|providence forge|"
              "quinton|new kent|charles city|amelia|amelia court house|sussex|king william|"
              "west point|manquin|aylett|montpelier|beaverdam|doswell|rockville|maidens|"
              "crozier|manakin-sabot|manakin sabot|moseley|chesterfield court house|enon|"
              "matoaca|ettrick|disputanta|mckenney|church road|bon air|lakeside|tuckahoe|"
              "innsbrook|laurel|montrose|east highland park|wakefield|waverly|stony creek|"
              "jarratt|lanexa|barhamsville||walkerton|king and queen",
    },
    "32820": {  # Memphis: Shelby, Fayette, Tipton (TN); DeSoto, Marshall, Tate, Benton, Tunica (MS); Crittenden (AR)
        "TN": "memphis|germantown|collierville|bartlett|cordova|arlington|lakeland|millington|covington|munford|"
              "atoka|oakland|somerville|rossville|piperton|brighton|drummonds|mason|gallaway|braden|"
              "moscow|eads|ellendale|frayser|whitehaven|raleigh|hickory hill|east memphis",
        "MS": "southaven|olive branch|horn lake|hernando|walls|nesbit|byhalia|holly springs|senatobia|coldwater|"
              "tunica|robinsonville|lake cormorant|potts camp|ashland|independence|sarah|tunica resorts",
        "AR": "west memphis|marion|earle|crawfordsville|sunset|turrell|jericho|horseshoe lake|edmondson|"
              "clarkedale|gilmore|jennette",
    },
    "41620": {  # Salt Lake City-Murray: Salt Lake and Tooele (Ogden and Provo are their own metros)
        "UT": "salt lake city|slc|salt lake|west valley city|west valley|west jordan|south jordan|sandy|draper|"
              "murray|midvale|cottonwood heights|holladay|millcreek|taylorsville|kearns|magna|herriman|"
              "riverton|bluffdale|south salt lake|tooele|grantsville|stansbury park|erda|lake point|"
              "stockton|wendover|vernon|ophir|rush valley|emigration canyon|brighton|alta|"
              "white city|copperton|granite|mill creek|olympus cove|south cottonwood",
    },
    "23420": {  # Fresno County
        "CA": "fresno|clovis|sanger|reedley|selma|kingsburg|kerman|coalinga|fowler|mendota|parlier|orange cove|"
              "firebaugh|huron|san joaquin|fresno state|caruthers|easton|del rey|friant|prather|"
              "auberry|shaver lake|tollhouse|biola|laton|riverdale|tranquillity|calwa|"
              "squaw valley|dunlap|raisin city|lanare|five points",
    },
    "13820": {  # Birmingham, AL: Jefferson, Shelby, St. Clair, Blount, Bibb, Chilton
        "AL": "birmingham|hoover|vestavia hills|homewood|mountain brook|bessemer|fultondale|gardendale|trussville|"
              "irondale|leeds|pelham|alabaster|helena|calera|chelsea|hueytown|mccalla|adamsville|center point|"
              "fairfield|tarrant|pinson|clay|moody|pell city|oneonta|clanton|jemison|columbiana|montevallo|"
              "inverness|midfield|brighton|lipscomb|pleasant grove|forestdale|graysville|brookside|"
              "warrior|kimberly|morris|mount olive|county line|sylvan springs|concord|minor|"
              "westover|harpersville|vincent|wilsonville|sterrett|indian springs village|"
              "maylene|shelby|wilton|ashville|odenville|springville|riverside|ragland|"
              "steele|margaret|argo|blountsville|cleveland|hayden|locust fork|snead|"
              "centreville|brent|west blocton|woodstock|thorsby|maplesville|verbena|"
              "liberty park|greystone|meadowbrook|lakeshore|",
    },
    "24340": {  # Grand Rapids: Kent, Ottawa, Ionia, Montcalm
        "MI": "grand rapids|wyoming|kentwood|walker|grandville|east grand rapids|rockford|cedar springs|lowell|"
              "byron center|caledonia|ada|cascade|comstock park|jenison|hudsonville|allendale|zeeland|holland|"
              "grand haven|spring lake|coopersville|ionia|belding|greenville|sparta|alto|kent city|"
              "sand lake|casnovia|marne|conklin|ravenna|nunica|ferrysburg|west olive|"
              "port sheldon|georgetown township|standale|plainfield township|belmont|"
              "portland|saranac|lake odessa|muir|pewamo|lyons|clarksville|"
              "stanton|carson city|edmore|howard city|lakeview|sheridan|six lakes|"
              "trufant|vestaburg|crystal|entrican|gowen|grattan|||",
    },
    "25540": {  # Hartford: the towns of Hartford, Tolland and Middlesex counties
        "CT": "hartford|west hartford|east hartford|new britain|bristol|manchester|glastonbury|wethersfield|"
              "rocky hill|newington|farmington|avon|simsbury|canton|granby|east granby|windsor|windsor locks|"
              "bloomfield|south windsor|enfield|suffield|east windsor|vernon|rockville|tolland|ellington|"
              "coventry|mansfield|storrs|willington|stafford|stafford springs|somers|hebron|bolton|andover|"
              "marlborough|berlin|kensington|plainville|southington|burlington|new hartford|cromwell|middletown|"
              "portland|east hampton|durham|haddam|higganum|east haddam|moodus|chester|essex|ivoryton|"
              "deep river|old saybrook|westbrook|clinton|killingworth|middlefield|rockfall|"
              "unionville|collinsville|weatherogue|tariffville|west simsbury|weatogue|broad brook|"
              "warehouse point|poquonock|wilson|hazardville|thompsonville|union|columbia|"
              "marlborough|amston|||east berlin|plantsville|milldale|"
              "forestville||||west suffield|north granby",
    },
}
# Washington, DC: the District is all one city, so any location in it counts.
WHOLE_STATE = {"47900": frozenset({"DC"})}
# New York: region.py's kind for a location within 50 miles of Midtown (geo coordinates).
RADIUS_KIND = {"35620": "nyc_metro"}
# What a page says about how its metro is drawn.
RADIUS_WORDS = {"35620": "within 50 miles of Midtown Manhattan, or in one of the five boroughs"}

# How a page names a town listed by a short or second name.
TOWN_NAMES = {"nyc": "New York", "new york city": "New York", "new york": "New York", "la": "Los Angeles",
              "sf": "San Francisco", "atl": "Atlanta", "jax": "Jacksonville", "okc": "Oklahoma City",
              "slc": "Salt Lake City", "indy": "Indianapolis", "dfw": "Dallas-Fort Worth", "bna": "Nashville",
              "st pete": "St. Petersburg", "st petersburg": "St. Petersburg", "st louis": "St. Louis",
              "st paul": "St. Paul", "lees summit": "Lee's Summit", "kansas city mo": "Kansas City",
              "kansas city ks": "Kansas City"}

TOWNS: dict[str, dict[str, frozenset]] = {
    cbsa: {st: frozenset(t.strip() for t in towns.split("|") if t.strip()) for st, towns in by_state.items()}
    for cbsa, by_state in _TOWNS.items()
}
# Connecticut's baseline-region kind takes precedence over "nyc_metro" in region.py. Recover
# radius membership from the existing offline gazetteer rather than changing that precedence
# or treating all Connecticut towns as local. These names go through the same state-qualified
# matching and remote exclusions as every other metro town; no geocoding requests are made.
TOWNS["35620"]["CT"] = frozenset(
    city for key, coords in GAZETTEER.items() for city, state in [key.rsplit("|", 1)]
    if state == "CT" and haversine_miles(*REGION.nyc_center, *coords) <= REGION.nyc_radius_miles
)

# A town name is read only as a whole token or at the end of one ("downtown denver", "ste 7 huntsville"),
# and not after these words, so "fort washington" is not "washington", "new boston" is not "boston" and
# "west palm beach" is not "palm beach" (each listed in its own right where it belongs).
_PREFIXES = frozenset({"north", "south", "east", "west", "new", "old", "upper", "lower", "fort", "port", "lake",
                       "mount", "little", "great", "glen", "grand", "palm", "point", "st", "el", "la", "los", "san",
                       "santa", "del", "de", "du", "le", "of", "city", "university", "college", "bay", "cape",
                       "center", "centre", "central", "middle", "royal", "rock", "spring", "falls", "hills",
                       "park", "valley", "white", "black", "green", "red", "blue", "silver", "golden"})
_NORMS = ((re.compile(r"[’`´]"), "'"), (re.compile(r"\bsaint\b"), "st"), (re.compile(r"\bst\.\s*"), "st "),
          (re.compile(r"\bste\.\s*"), "ste "), (re.compile(r"\bft\.?\s+"), "fort "),
          (re.compile(r"\bmt\.?\s+"), "mount "), (re.compile(r"&amp;"), "&"))
_COARSE = re.compile(r"[,;()/|•>.\n\[\]{}~:]|\s[-–—]+\s|[–—]")
_TRAIL_STATE = re.compile(r"\s+([a-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$")
_TRAIL_NUM = re.compile(r"\s*#?\d+\s*$")
# What follows a town without being part of it: "Boston MA USA", "Milwaukee HQ", "Seattle Campus",
# "Greater Boston Area", "Denver Metropolitan Area", "Salt Lake City UT Refinery".
_TRAIL_JUNK = re.compile(r"\s+(?:usa|us|u s a|united states(?: of america)?|hq|whq|headquarters|main campus|campus|"
                         r"offices?|refinery|plant|site|metropolitan area|metro area|metroplex|area)$")
_STATE_CODES = frozenset(
    "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok "
    "or pa ri sc sd tn tx ut vt va wa wv wi wy dc pr".split())
# A location made only of these (and its state's name) names no place: "NJ", "USA", "Hybrid", "State of".
# A state's own name is noise only in that state: "Washington, PA" and "Delaware, OH" are towns (_named).
_STATE_NAME = {code: name for name, code in STATE_NAMES.items()}
_NOISE = (_STATE_CODES
          | frozenset({"us", "usa", "u s", "u s a", "united states", "united states of america", "america", "hybrid",
                       "onsite", "on site", "on-site", "in office", "in-office", "office", "home office", "hq",
                       "headquarters", "state of", "statewide", "any city", "main campus", "campus", "all",
                       "multiple locations", "various locations", "various", "nationwide"}))


def _clean(v: str) -> str:
    while True:
        old = v
        v = _TRAIL_JUNK.sub("", _TRAIL_NUM.sub("", v).strip()).strip()
        m = _TRAIL_STATE.search(v)
        if m and m.group(1) in _STATE_CODES and m.start() > 0:
            v = v[:m.start()].strip()
        if v == old:
            return v


def place_tokens(loc: str) -> set[str]:
    """The pieces of a location string a town name can be: "Denver, CO, 80205" -> {"denver", "co", "80205"};
    "US.CO.Denver", "USA - Denver", "Rocky Hill, CT (Hartford)", "St. Petersburg/Tampa" read alike."""
    s = (loc or "").lower()
    for pat, rep in _NORMS:
        s = pat.sub(rep, s)
    out = set()
    for c in _COARSE.split(s):
        c = " ".join(c.split())
        if not c:
            continue
        for v in {c, c.replace("-", " "), *c.split("-")}:
            v = _clean(" ".join(v.split()))
            if v:
                out.add(v)
    return out


def _town(token: str, towns: frozenset) -> str | None:
    """The town a token names, or None: the whole token, or the longest town name it ends with when the
    word before that is not a prefix."""
    if token in towns:
        return token
    words = token.split()
    for i in range(1, len(words)):
        tail = " ".join(words[i:])
        if tail in towns:
            return tail if words[i - 1] not in _PREFIXES else None
    return None


def place_key(name: str) -> str:
    """A place name read the way the town lists are written: "St. Louis" -> "st louis"."""
    s = (name or "").lower()
    for pat, rep in _NORMS:
        s = pat.sub(rep, s)
    return _clean(" ".join(s.split()))


# Work-from-home wording REMOTE_RE does not catch: "NJ, Working at Home - New Jersey".
_WORK_HOME = re.compile(r"\b(?:working at home|work at home|home[- ]based|telecommut\w*|telework\w*)\b", re.I)
# The District named in a region filed under another state ("Washington, District of Columbia" under WA).
_DC_LOC = re.compile(r"\bdistrict of columbia\b|\bwashington,?\s*d\.?\s?c\b\.?", re.I)


def remote_loc(g: dict) -> bool:
    """A region that is a remote role (US-wide, or remote within one state), never a place."""
    loc = str(g.get("loc") or "")
    return (g.get("kind") == "remote" or g.get("state") == "Remote" or bool(REMOTE_RE.search(loc))
            or bool(_WORK_HOME.search(loc)))


def _named(g: dict) -> set[str]:
    """The tokens of a region's location that can name a town (not a state, the country or a work mode)."""
    toks = place_tokens(str(g.get("loc") or ""))
    own = _STATE_NAME.get(g.get("state") or "")
    named = {t for t in toks if t not in _NOISE and t != own}
    # Bare "New York" is the city to region.py, which placed it inside the radius (kind nyc_metro).
    if g.get("state") == "NY" and g.get("kind") == "nyc_metro" and "new york" in toks:
        named.add("new york")
    return named


def region_metros(g: dict) -> frozenset[str]:
    """The CBSAs (of the 50) one region is inside, by the rules in this module's docstring."""
    if not isinstance(g, dict) or g.get("kind") == "canada" or remote_loc(g):
        return frozenset()
    st, loc = g.get("state"), str(g.get("loc") or "")
    hit = set()
    for cbsa, states in WHOLE_STATE.items():          # the District is one city, "DC" alone included
        if st in states or (cbsa == "47900" and _DC_LOC.search(loc)):
            hit.add(cbsa)
    named = _named(g)
    if not named:                                     # a state, the country or a work mode, never a town
        return frozenset(hit)
    for cbsa, kind in RADIUS_KIND.items():
        if g.get("kind") == kind:
            hit.add(cbsa)
    for cbsa, by_state in TOWNS.items():
        towns = by_state.get(st)
        if towns and cbsa not in hit and any(_town(t, towns) for t in named):
            hit.add(cbsa)
    return frozenset(hit)


def region_town(g: dict, cbsa: str) -> str | None:
    """The listed town of `cbsa` a region names ("denver" for "Hybrid - Denver, CO"), or None when it
    matched by radius or as the District rather than by a town name."""
    towns = TOWNS.get(cbsa, {}).get(g.get("state"))
    named = _named(g) if isinstance(g, dict) else set()
    if cbsa in RADIUS_KIND and "new york" in named:
        return "new york"
    if not towns:
        return None
    hits = sorted({h for h in (_town(t, towns) for t in named) if h}, key=lambda h: (-len(h), h))
    return hits[0] if hits else None


def us_remote(x: dict) -> bool:
    """A role that can be done from anywhere in the US: a remote region that names no state."""
    return any(isinstance(g, dict) and (g.get("kind") == "remote" or g.get("state") == "Remote")
               and g.get("state") in (None, "", "Remote") for g in x.get("regions") or [])


def metro_slug(m: dict) -> str:
    """ "denver", "washington-dc", "st-louis": the city's folder under /internships/near/."""
    city = m["city"] + (" DC" if m["state"] == "DC" else "")
    return re.sub(r"[^a-z0-9]+", "-", city.lower().replace(".", "")).strip("-")


def metro_label(m: dict) -> str:
    """ "Denver, CO", "Washington, DC"."""
    return f"{m['city']}, {m['state']}"


def metro_states(cbsa: str) -> list[str]:
    """The state codes a metro's towns are in, the anchor city's first."""
    m = next(mm for mm in METROS if mm["cbsa"] == cbsa)
    states = [m["state"]] + sorted(s for s in TOWNS.get(cbsa, {}) if s != m["state"])
    if cbsa == "35620":
        states.append("NJ")       # the 50-mile radius takes in northern New Jersey
    return list(dict.fromkeys(states))
