02805 shared playground - week 5 release (frozen snapshot, 2026-08-26)
Full plain-text Wikipedia article for each of the 303 characters in
Category:Marvel Comics superheroes - the same 303 nodes as week1_nodes.tsv.

One file per character. The filename is the node_id, URL-encoded, because a
few titles contain characters a filesystem will not take (Mark_Hazzard%3A_Merc).
urllib.parse.unquote the stem and it matches node_id exactly - see the loading
snippet on the course data page.
