"""
Scrapy Item definitions for LinkedIn data structures.
"""
import scrapy


class ReactorItem(scrapy.Item):
    """A person who reacted to a LinkedIn post."""
    fullName = scrapy.Field()
    headline = scrapy.Field()
    profileUrl = scrapy.Field()
    reactionType = scrapy.Field()


class ProfileItem(scrapy.Item):
    """Enriched data from a LinkedIn profile page."""
    linkedinUrl = scrapy.Field()
    jobTitle = scrapy.Field()
    company = scrapy.Field()
    companyUrl = scrapy.Field()
