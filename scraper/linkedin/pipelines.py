"""
Scrapy Item Pipelines — clean and normalize scraped LinkedIn data.
"""


class CleanFieldsPipeline:
    """Strip whitespace and normalize empty strings on all item fields."""

    def process_item(self, item, spider):
        for field in item.fields:
            if field in item and item[field] is not None:
                item[field] = str(item[field]).strip()
            elif field not in item:
                item[field] = ""
        return item
